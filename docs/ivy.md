# Ivy

`ivy` is Grok/Ivy on the `gtwy/asmltr` fork. We never push to `jarethmt/asmltr`. Eve: pull `ivy` into your `main` if you want pieces.

## Take for every asmltr install

Engine-agnostic. Worth taking even if you never run Grok.

- Per-turn Self silo write + last-topics inject on a fresh session (not a session-close flush).
- SSE leftover flush when the reader closes, so a `done` frame without trailing newlines still fires `onDone`.
- Dashboard nginx `/v2/`: `proxy_buffering off`, `proxy_cache off`, `gzip off`, HTTP/1.1. SSE + gzip stalls.
- SessionDetail: autoscroll the inner transcript pane (FloatingWindow), not the modal or the page.
- `applySegment` must match stored outbound (replace growing snapshots; append only real deltas; do not trim).
- Web live: keep the last finished block, not a longer status/narration mash. Discord already did this. Stream `onTool` must map to `onToolCall` so the draft block closes; otherwise onDone keeps the glued longer text.
- Live deltas: `onDelta` uses the same `joinText` as persist (period-space), not raw `+=`. Raw append glues `on.Yes`.
- Live list: past-idle no-pid web cards leave Live. `GET /api/sessions?active=1` excludes rows past `last_activity` + idle and flips those rows to `ended` on read. History stays. Do not show an Idle badge. Same session key can come back Active on a later message.
- Engines help: put CLI login commands on their own line so they do not wrap mid-flag.
- Dashboard nginx: `client_max_body_size 32m` (default 1m 413s Live attach). Live composer POSTs raw bytes to `/v2/upload` (same as recordings); core caps original files at 25MB. Host 80g is not enough if the container nginx is still 1m.

## Take if you want Grok as an engine — not Ivy-only

Helps any site that runs the Grok CLI.

- `core/src/engines/grok.js` adapter
- Grok text tokens as live deltas without trim (mashed words if you trim or treat snapshots as appends)
- Keep period-space when joining grok narration blocks. Space-only tokens were dropped as empty; later sentences arrived without a leading space (`time.The`).
- `--effort high` and auto-xhigh on code
- Engines copy: `grok login --device-auth` on its own line
- Finite idle as a grok-session feature (we default 30 minutes; the idea is reusable)
- Node 24 + better-sqlite3 11 ABRT: ObjectWrap dtor → RemoveEnvironmentCleanupHook when env is nullptr. keep-until-listen was insufficient — post-listen GC during grok heap growth still ABRTs. Keep+reuse Statements (SQL-keyed Map) for the process lifetime. Do not disarm after listen.
- Grok 4.6 context is 500k with no text output limit. The adapter must omit context and max-output flags.
- Take `ASMLTR_GROK_MAX_TURNS=20` and `ASMLTR_GROK_TIMEOUT_MS=600000`.
- Do not port `ASMLTR_MAX_THINKING_TOKENS=4000`, opus, haiku, or `ASMLTR_MODEL`. Inherited Claude leftovers (engines fallback `claude`, runtime getModel opus, thinking 4000) are Claude-engine only.

## Our box only, skip

Do not merge these.

- `ASSISTANT_NAME=ivy`
- ivy stream slug
- `env.ivy.example` / `seed.ivy.example` branding
- osiris user systemd units (`asmltr-core` / `asmltr-collector` / `asmltr-manager`)
- `ivy.gtwy.net` and host nginx site files
- live `.env`, tokens, `ASMLTR_AUTH_SECRET`, insights token, `vault.pass`
- `docker-compose.local.yml`
- Authelia leftover notes (Authelia was removed)
