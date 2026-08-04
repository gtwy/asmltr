# `device` — generic device gateway

A platform-agnostic gateway that turns **any device with a network stack** — a Raspberry Pi kiosk, an
ESP32 appliance, a desk buddy, a custom voice box — into a first-class asmltr channel. It's the
generic base the [`android`](android.md) connector's gateway proved out, minus anything
OS-specific. Platform connectors (`android`, and iOS later) layer their own extras (device-control
RPC, app download, on-device wake models) on top of this same shape.

Because a device turn runs through the core like any other channel, the device gets identity/trust,
moderation, sessions, redaction, and the shared event stream for free — so it shows up in
`asmltr map` / `ls`, is takeover-able from the web GUI, and `asmltr send device <id>` / announcements /
steer / read-aloud push straight to it.

## Transport

No new dependencies — plain HTTP + SSE + a device token, identical in shape to `android`:

| Direction | Call | Notes |
|-----------|------|-------|
| device → server | `POST /gw/turn` `{ token, device, name?, text, capabilities? }` | acks immediately; the reply **streams over the SSE**, not this response |
| server → device | `GET /gw/stream?token=&device=&name=` | SSE frames: `ready` · `delta` · `thinking` · `tool` · `tool_result` · `done` · `inject` · `speak` · `error` |
| manager → device | `POST /out` `{ target, text, kind? }` | `inject` (steer text into a turn) or `speak` (read aloud without a turn) |

A thin client needs no on-device speech stack and no provider keys — speech is **proxied**:
`POST /gw/transcribe` (audio → text) and `POST /gw/tts` (text → audio). Keys stay on the server.

Other endpoints: `/gw/abort`, `/gw/forget` (clear context), `/gw/presence`, `/gw/devices`,
`/gw/sessions` (browse/attach any asmltr session), `/health`.

## Config

| Key | Default | Meaning |
|-----|---------|---------|
| `http_port` | `3028` | gateway + `/out` port |
| `bind_host` | `127.0.0.1` | bind address (a reverse proxy fronts it) |
| `keys_file` | `keys.json` | gitignored device tokens (`token → trust identity`), copy from `keys.json.example` |
| `require_token` | `true` | require a device token |
| `surface_label` | `device` | what to call this surface in prompts (e.g. `"desk buddy"`) |
| `conversation_scope` | `device` | `device` = one thread per device · `identity` = one continuous thread per user across their devices |
| `default_capabilities` | `{}` | fallback caps when a turn omits them, e.g. `{"audio_out":true,"screen":{"w":480,"h":800}}` |

## Device capabilities

A turn may carry `capabilities` (screen dimensions, `audio_in`, `audio_out`), else the instance's
`default_capabilities` apply. The connector injects a one-line **surface descriptor** into the turn's
`system_prompt_extra` telling the model what the device can do — *only when it changes* from the last
turn on that conversation (first turn, or a genuine change), never per-turn: the model retains it via
conversation history, so re-sending it every turn would be wasted tokens. An `audio_out` device is told
to write speakable prose (no markdown); a screen is told it can show formatted output.

## conversation_scope

- **`device`** (default): `conversation_key = device:<instance>:device:<deviceId>` — each device its own
  thread. The general case.
- **`identity`**: `conversation_key = device:<instance>:identity:<callerIdentity>` — every device a
  user talks through shares **one continuous thread**, so the conversation is interface-agnostic while
  each device stays an individually addressable wire for `/out`.
