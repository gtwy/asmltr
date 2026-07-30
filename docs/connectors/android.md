# Android connector (device gateway)

The Android connector (`connectors/types/android/index.js`) is the backend half of the **asmltr mobile
assistant** — the native Android app. Unlike the chat connectors (Discord, Telegram, …) which are pure
message transports, this one is a **device gateway**: it carries a voice/chat stream *and* a persistent
control link that lets any agent session actuate the phone, read notifications aloud, and receive
proactive read-aloud pushes. It's SSE + POST over the shared core, bound to `127.0.0.1` behind the proxy.

The paired client is the [mobile app](#the-mobile-app) (a Capacitor WebView + a native assist layer).

---

## How it works

Two independent long-lived streams per device, plus request/response endpoints:

- **Chat stream** (`GET /gw/stream`) — held open by the app's WebView. The app POSTs a turn to
  `/gw/turn`; the reply streams back down this SSE as `delta` / `thinking` / `tool` / `tool_result` /
  `done` frames. Ephemeral: it lives only while the assistant UI is open.
- **Control link** (`GET /gw/control`) — held open by the app's native foreground service, so it stays
  connected **even when the UI is closed**. This is what makes the phone drivable from any agent
  session, and what receives `speak` (read-aloud) frames headless. It carries `device_rpc` (device
  actuation) and `speak` frames.
- **Device RPC** (`POST /gw/rpc` → `device_rpc` frame → app runs it natively → `POST /gw/rpc-result`)
  — the mechanism behind device control (open apps, set volume, gestures, screen read/screenshot).
- **Edge speech** (`POST /gw/transcribe`, `POST /gw/tts`) — proxied so the phone needs only its device
  token, not the speech provider key.

The connector authenticates each device by a **device token** (`keys.json`, or `require_token:false`
in dev). The token maps to a caller identity used for trust resolution, exactly like other channels.

---

## Conversation key

```
android:<instanceId>:device:<deviceId>
```

One core session per device, so the conversation is continuous across app opens. The app can also
*attach* to any other session (the overlay's session switcher) and direct its next message there.

---

## Endpoints

All under `/gw` on the connector's `http_port` (default `3027`, bound `127.0.0.1`), token-authed:

| Endpoint | Purpose |
|---|---|
| `GET /gw/stream` | Chat SSE the WebView holds open (`ready`/`delta`/`thinking`/`tool`/`tool_result`/`done`/`inject`/`speak`). |
| `GET /gw/control` | Persistent control SSE the native service holds open (`device_rpc`, `speak`). |
| `POST /gw/turn` | Send a user turn (optionally targeting another session's key). |
| `POST /gw/rpc` · `POST /gw/rpc-result` | Device actuation round-trip (native tools). |
| `GET /gw/sessions` · `GET /gw/history` | List sessions / rehydrate a conversation's bubbles. |
| `POST /gw/forget` | Clear the device's core session (fresh context). |
| `GET /gw/theme` | Palette + VAD + wake + stop-phrase config for the app UI. |
| `GET /gw/wake` · `POST /gw/voice-config` | Wake-word model URL / persist voice (STT) settings. |
| `POST /gw/transcribe` · `POST /gw/tts` | Edge speech (STT/TTS) proxied through the core. |
| `POST /gw/notify-triage` | Notification reader → core's default engine returns `{speak, priority, synopsis}`. |
| `GET /gw/presence` | Is any device reachable (chat stream or control link)? Used by the notify ladder. |
| `GET /gw/devices` · `GET /gw/download` · `GET /gw/app` | Actuable device list / APK download / app-version manifest. |
| `POST /out` | Manager→device push. `kind:'inject'` steers text into a turn; `kind:'speak'` reads text **aloud** (asmltr notify). A `*`/empty target broadcasts to every connected device + the control link. |

---

## Configuration

Discoverable live at `GET /types` on the manager. From the connector's `configSchema`:

| Field | Default | Purpose |
|---|---|---|
| `http_port` | `3027` | Device-gateway + `/out` port (bound `127.0.0.1`). |
| `bind_host` | `127.0.0.1` | Interface to bind. |
| `require_token` | `true` | Require a valid device token on every call (turn it off only in dev). |
| `keys_file` | `<connector>/keys.json` | Device tokens → identities. |

### Create an instance

```bash
curl -s -X POST 127.0.0.1:3024/instances -H 'Content-Type: application/json' -d '{
  "type":"android",
  "name":"my-phone-gateway",
  "enabled":true,
  "config":{ "http_port":3027, "require_token":true }
}'
```

Then add a device token to the connector's `keys.json` and paste it into the app's **⚙ → Device token**.

---

## The mobile app

The native app (Capacitor) is built from `mobile/` and published as a signed APK to GitHub Releases;
the connector serves the latest at `GET /gw/download`. Beyond the chat/voice overlay it adds a native
assist layer:

- **Floating overlay** (`OverlayService`) — a persistent voice/chat panel that survives swipe-home.
- **Persistent control link** (`DeviceControlService`) — keeps the phone drivable + reads `speak`
  frames aloud with the app fully closed.
- **Device control** (`AsmltrAccessibilityService` + `DeviceTools`) — launch apps, volume/settings,
  gestures, screen read, screenshots (opt-in accessibility permission).
- **Wake word** (`WakeWord`, offline Vosk) — say the configured phrase to open the assistant hands-free.
- **Headset button** (`AssistActivity`) — registers asmltr for the BT/wired assistant-button chooser.
- **Notification reader** (`AsmltrNotificationService`) — see below.

Voice, wake word, VAD, and stop-phrases are global STT settings shared with the web GUI/TUI (see the
[dashboard](../dashboard.md) Voice settings).

---

## Read-aloud & the notification reader

The gateway is the device end of the two [notify / read-aloud](../NOTIFY-READ-ALOUD.md) capabilities:

- **asmltr notify (proactive → you).** The core's notify ladder pushes a `speak` frame here (via the
  manager `/send` with `kind:'speak'`); the app (or the headless control service) reads it aloud. Used
  by [Schedules](../SCHEDULES.md) to deliver the morning brief.
- **Notification reader (phone notifications → spoken synopsis).** A `NotificationListenerService`
  captures incoming notifications, gates them (enabled · headphones connected · per-app deny · noise
  filters), collects a ~3-second burst, and asks the core (`POST /gw/notify-triage` → the **default
  reasoning engine**, on-device, not a metered API) for `{speak, priority, synopsis}`. If it clears the
  priority threshold, the app reads the synopsis aloud over Bluetooth. This path is deliberately native
  and local — it never falls back to push/Telegram (that's the separate asmltr-notify system).

Configure both in the app's **⚙ settings** (Notifications read-aloud) and the delivery ladder on the
dashboard's **Schedules → Notify delivery** panel.

See [Connectors](index.md) for the full manager API (patch, restart, logs, delete).
