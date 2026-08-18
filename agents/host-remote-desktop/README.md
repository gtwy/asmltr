# host-remote-desktop

Native **Windows host agent** for asmltr's custom WebRTC remote-desktop capability
(see [`docs/REMOTE-DESKTOP.md`](../../docs/REMOTE-DESKTOP.md)). A single self-contained Go binary that:

1. **Dials OUT** to the asmltr signaling broker — never listens for inbound. Registers as a host over
   an SSE stream and POSTs signaling back.
2. **Captures the real desktop** (DXGI Desktop Duplication via ffmpeg `ddagrab`) + optional system
   audio, encodes **H.264** (low-latency) / **Opus**, and publishes them as WebRTC media tracks that
   flow **peer-to-peer** (ICE hole-punched; the broker never sees the media).
3. **Injects mouse/keyboard** received on a trust-gated `control` data channel via
   `user32!SendInput` — only when the broker stamped the session `control:true`.

Built with [Pion WebRTC v4](https://github.com/pion/webrtc) (pure Go). No CGO — `SendInput` is called
through `syscall`, so it cross-compiles cleanly from Linux/macOS to a lone Windows `.exe`.

---

## Build

Requires Go **1.24+** (Pion v4 requirement).

### Self-contained (recommended — ffmpeg embedded, single-file drop)

```bash
cd agents/host-remote-desktop
scripts/build-windows.sh          # fetches a static win64 ffmpeg, embeds it, builds the .exe
```

This runs `scripts/fetch-ffmpeg.sh` (downloads the **BtbN win64-gpl** static ffmpeg, which includes
the `ddagrab` filter), drops it at `assets/ffmpeg.exe`, and builds with `-tags embed_ffmpeg` so the
binary `go:embed`s it. The resulting `host-remote-desktop.exe` needs **nothing** installed on the
target box — on first run it extracts ffmpeg next to itself. ffmpeg is **not** committed to git; it is
fetched at build time.

### Plain build (agent locates ffmpeg at runtime)

```bash
cd agents/host-remote-desktop
GOOS=windows GOARCH=amd64 go build -o host-remote-desktop.exe .
```

Without the embed tag the agent looks for `ffmpeg.exe` in its app dir, then on `PATH`, then honors an
explicit `ffmpeg_path` in config. Use this for CI/compile checks or when ffmpeg is provisioned
separately.

### ffmpeg dependency, precisely

| Build              | Where ffmpeg comes from                                             |
|--------------------|---------------------------------------------------------------------|
| `-tags embed_ffmpeg` | Baked into the exe; extracted to `<app_dir>\ffmpeg.exe` on first run |
| default            | `ffmpeg_path` → `<app_dir>\ffmpeg.exe` → `ffmpeg.exe` on `PATH`      |

The confirmed-good build class is BtbN `ffmpeg-master-latest-win64-gpl` (ddagrab present, runs on
Windows 11 amd64). Pin a specific release for reproducibility with
`FFMPEG_URL=... scripts/fetch-ffmpeg.sh`.

---

## Configuration

Resolved in precedence order: **defaults → JSON config file → environment → flags**. No host, path, or
secret is hardcoded. See [`config.example.json`](config.example.json).

| Config key        | Env (`ASMLTR_RD_*` / `RD_*`) | Flag             | Meaning                                                            |
|-------------------|------------------------------|------------------|-------------------------------------------------------------------|
| `broker_url`      | `ASMLTR_RD_BROKER`           | `-broker`        | **required** broker base URL, e.g. `https://asmltr.eve.thoughtspacedesigns.com` |
| `token`           | `ASMLTR_RD_TOKEN`            | `-token`         | device token (an entry in the broker `keys.json`)                 |
| `host_id`         | `ASMLTR_RD_HOST_ID`          | `-host-id`       | id to register under (default: machine hostname)                  |
| `name`            | `ASMLTR_RD_NAME`             | `-name`          | display name shown to viewers                                     |
| `control`         | `ASMLTR_RD_CONTROL`          | `-control`       | accept the control data channel (mouse/keyboard)                  |
| `audio`           | `ASMLTR_RD_AUDIO`            | `-audio`         | publish a system-audio track                                      |
| `capture_backend` | `ASMLTR_RD_CAPTURE`          | `-capture`       | `ddagrab` (default, DXGI) or `gdigrab` (software fallback)        |
| `output_index`    | —                            | —                | monitor index for ddagrab (0 = primary)                           |
| `framerate`       | `ASMLTR_RD_FPS`              | `-fps`           | capture framerate (default 30)                                    |
| `video_bitrate`   | `ASMLTR_RD_VBITRATE`         | `-vbitrate`      | e.g. `8M`                                                         |
| `audio_device`    | `ASMLTR_RD_AUDIO_DEVICE`     | `-audio-device`  | dshow loopback device name (required if `audio` is on)            |
| `app_dir`         | `ASMLTR_RD_APP_DIR`          | `-app-dir`       | working/drop dir (default: dir of the exe)                        |
| `ffmpeg_path`     | `ASMLTR_RD_FFMPEG`           | `-ffmpeg`        | explicit ffmpeg path (overrides auto-locate)                      |
| —                 | `ASMLTR_RD_CONFIG`           | `-config`        | path to the JSON config file                                      |

Auth is a single device token sent as `?token=` on the GETs (`/rd/stream`, `/rd/ice-config`) and in the
JSON body of `POST /rd/msg`.

---

## Signaling flow (what the agent speaks)

```
GET  /rd/ice-config?token=                      → { iceServers:[…], turn_enabled }   (STUN always; TURN only if enabled)
GET  /rd/stream?token=&role=host&host_id=&name=&control=1&audio=1   (SSE; registers this host, holds open)
      ← ready
      ← offer_request { session_id, control }   → build a Pion offer for that session
      ← sdp   { session_id, sdp }               → SetRemoteDescription (viewer's answer)
      ← ice   { session_id, candidate }         → AddICECandidate
      ← bye   { session_id }                    → tear the session down
POST /rd/msg { token, type:"sdp", session_id, role:"host", sdp:{…} }        (our offer / renegotiation)
POST /rd/msg { token, type:"ice", session_id, role:"host", candidate:{…} }  (trickled local candidates)
POST /rd/msg { token, type:"bye", session_id, reason }                      (teardown)
```

`role:"host"` is **required** on every `sdp`/`ice` POST: host and viewer share the same trust identity,
so the broker needs the explicit role to route the relay (omitting it errors 400). Media is direct
peer-to-peer; only SDP/ICE transit the broker.

## ffmpeg command lines

**Video — ddagrab (DXGI Desktop Duplication, default):**

```
ffmpeg -hide_banner -loglevel warning \
  -f lavfi -i ddagrab=output_idx=0:framerate=30 \
  -vf hwdownload,format=bgra \
  -c:v libx264 -preset ultrafast -tune zerolatency -profile:v baseline -pix_fmt yuv420p \
  -g 60 -b:v 8M -maxrate 8M -bufsize 1M -bf 0 \
  -f h264 pipe:1
```

**Video — gdigrab (software fallback):**

```
ffmpeg -hide_banner -loglevel warning -f gdigrab -framerate 30 -i desktop \
  -c:v libx264 -preset ultrafast -tune zerolatency -profile:v baseline -pix_fmt yuv420p \
  -g 60 -b:v 8M -maxrate 8M -bufsize 1M -bf 0 -f h264 pipe:1
```

**Audio — dshow loopback → Opus/Ogg (only when `audio` on and `audio_device` set):**

```
ffmpeg -hide_banner -loglevel warning -f dshow -i audio=<device> \
  -c:a libopus -b:a 96k -application lowdelay -frame_duration 20 -f ogg pipe:1
```

The agent parses ffmpeg's H.264 (Annex-B, via `h264reader`) and Opus/Ogg (via `oggreader`) stdout into
Pion `media.Sample`s, one goroutine per stream, started when the peer connection reaches `connected`.

> **Audio note:** stock ffmpeg has no direct WASAPI loopback *input* — capture goes through a dshow
> loopback device (e.g. `virtual-audio-capturer` from the screen-capturer-recorder package, or a
> "Stereo Mix" device). Set its exact name in `audio_device`. Video is the primary path; audio is
> opt-in and best-effort.

## Control data-channel JSON schema

The `control` channel is **pre-negotiated** (`negotiated:true, id:0, ordered:true, label:"control"`) —
the host creates it with the same settings; it exists only when the session carries a control grant.
Coordinates are **normalized `[0,1]`** fractions of the remote screen, mapped to Windows absolute
cursor coords (`x_abs = round(x*65535)`, likewise `y`) over the virtual desktop.

```jsonc
// pointer
{"t":"move",  "x":0.42, "y":0.87}
{"t":"click", "x":0.42, "y":0.87, "button":"left"}     // button ∈ left|right|middle (default left)
{"t":"down",  "x":0.42, "y":0.87, "button":"left"}     // press & hold
{"t":"up",    "x":0.42, "y":0.87, "button":"left"}     // release
{"t":"scroll","dx":0, "dy":120}                        // wheel px deltas; sign = direction

// keyboard — match on UI-Events `code`; `key` is the exact char (shifted symbols / unicode fallback)
{"t":"key", "code":"KeyA",   "key":"a", "down":true}
{"t":"key", "code":"KeyA",   "key":"a", "down":false}  // KEYEVENTF_KEYUP
{"t":"key", "code":"Enter",  "down":true}
{"t":"key", "code":"Digit1", "key":"1", "down":true}
```

`code` → Windows virtual-key is handled for letters (`KeyA`..`KeyZ`), digits (`Digit0`..`Digit9`,
`Numpad0`..`Numpad9`), function keys (`F1`..`F24`), and the full named set (Enter, Backspace, Tab,
Escape, Space, arrows, nav cluster, modifiers `Shift/Control/Alt/Meta` Left/Right, punctuation, numpad
ops, etc.). Unmapped codes fall back to typing `key` via `KEYEVENTF_UNICODE`.

**Trust gate (defense in depth):** the agent injects input **only** if the broker stamped the session
`control:true` *and* the agent itself was started with `control` enabled. Any control message on a
non-control session is refused and logged.

---

## Run on Windows (test procedure)

Target confirmed: **Windows 11, amd64**, drop dir `C:\Users\suppo\asmltr-rd`.

1. **Drop the files.** Copy the self-contained build to the box:
   ```
   C:\Users\suppo\asmltr-rd\host-remote-desktop.exe
   C:\Users\suppo\asmltr-rd\config.json          (from config.example.json, with the real token)
   ```
   (If you built the embedded variant, ffmpeg self-extracts here on first run. Otherwise also drop
   `ffmpeg.exe` in this folder.)

2. **Fill in config.json** — `broker_url`, `token`, a `host_id`/`name`, and `control:true` if you want
   remote input. Leave `audio:false` unless you have a loopback device to name.

3. **Run it** (from a normal command prompt in the drop dir):
   ```
   cd C:\Users\suppo\asmltr-rd
   host-remote-desktop.exe -config config.json -verbose
   ```
   Or all-flags, no file:
   ```
   host-remote-desktop.exe -broker https://asmltr.eve.thoughtspacedesigns.com -token <TOKEN> ^
     -host-id windows-desk-1 -name "Office PC" -control true -verbose
   ```

4. **Expect these logs:** `ffmpeg resolved to …`, `registered with broker as host_id=…`, then on a
   viewer connecting: `offer_request session=… control(…)`, `connection state connected`,
   `starting capture`, and the `video ffmpeg: …` command line.

5. **Verify end-to-end:**
   - Open the asmltr viewer (mobile app / dashboard), pick this host → you should see the **live
     desktop** (direct P2P; check `connection state connected` in the log).
   - With a control grant, move/click/type in the viewer → the host cursor and keyboard respond. The
     log shows `control channel open (grant=true)`.
   - Confirm a **view-only** session refuses input: the log prints `REFUSING control message — session
     has no control grant`.

6. **UAC note:** to drive elevated windows (running-as-admin apps, the secure desktop / UAC prompt),
   run the agent elevated (**Run as administrator**). A non-elevated agent can still control normal
   windows.

7. **Run at boot (optional):** register a Scheduled Task (At log on, highest privileges) pointing at
   the exe with `-config config.json`, so the host is available without a manual launch.

---

## Layout

| File                     | Role                                                                    |
|--------------------------|-------------------------------------------------------------------------|
| `main.go`                | Entry point, config load, signal handling                               |
| `config.go`              | Config resolution (defaults → file → env → flags)                       |
| `signaling.go`           | SSE stream client + `POST /rd/msg` (with `role:"host"`)                  |
| `webrtc.go`              | Pion peer connection: ICE fetch, offer, tracks, control channel, sessions |
| `capture.go`             | ffmpeg command builders + H.264/Opus → Pion sample pumps                |
| `ffmpeg.go`              | Locate/extract ffmpeg (embedded → app dir → PATH)                       |
| `ffmpeg_embed.go`        | `//go:build embed_ffmpeg` — `go:embed assets/ffmpeg.exe`                 |
| `ffmpeg_noembed.go`      | default — no embedded ffmpeg                                             |
| `control.go`             | Control data-channel JSON schema (platform-neutral)                     |
| `input_windows.go`       | `SendInput` injection (mouse/keyboard) via `syscall`, no CGO            |
| `input_other.go`         | non-Windows stub (refuses injection) so it builds for dev on Linux/macOS |
| `scripts/fetch-ffmpeg.sh`| Download the static win64 ffmpeg into `assets/`                          |
| `scripts/build-windows.sh`| Fetch + build the self-contained exe                                   |
