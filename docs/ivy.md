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
- Email: the IMAP watcher tracks a UID cursor and never set `\Seen`, so Gmail still looked unread after Ivy handled mail. After a message is actually handled (watch path), set `\Seen`. `asmltr mail read` marks seen by default (`--keep-unread` to peek). Skip self / noreply / bounce so security-alert mail can stay unread.
- Moderation: default OpenAI classifier (`gpt-5-nano`) is a reasoning model. Uncapped it added ~2–3.5s of synchronous dead time on every inbound that is not bypassed. Cap `reasoning_effort: 'minimal'` on gpt-5-family models only (`ASMLTR_MODERATION_REASONING_EFFORT`; empty/`off`/`none` disables). Logs include `duration_ms`.

## Take if you want Grok as an engine — not Ivy-only

Helps any site that runs the Grok CLI.

- `core/src/engines/grok.js` adapter
- Grok text tokens as live deltas without trim (mashed words if you trim or treat snapshots as appends)
- Keep period-space when joining grok narration blocks. Space-only tokens were dropped as empty; later sentences arrived without a leading space (`time.The`).
- Always pass `--effort`. Baseline `ASMLTR_GROK_EFFORT` (Ivy: `medium`; unset still defaults `high` for other installs). Auto-`high` on lookup/research/Corona/Rolodex/troubleshooting. Auto-`xhigh` on git/code/deep-dive (implement, refactor, write/patch code, commit, PR, "deep dive"). HOME cwd is never a project. Never `process.cwd()`. Score the current user message only (`effortPrompt`) — not drainObserved/catch-up. One-shot next-effort still wins (including over inbound email); `complete()` skips auto-raise. Inbound email (`channel === "email"`) is always xhigh after that one-shot (100 turns, 25-minute timeout). Discord xhigh stays 60 turns / 30 minutes. Other channels stay three-tier. Tight: do not treat bare "fix" as xhigh. Do not port last-effort inherit or a generic `XHIGH_CHANNELS` list.
- Engines copy: `grok login --device-auth` on its own line
- Finite idle as a grok-session feature (we default 30 minutes; the idea is reusable)
- Node 24 + better-sqlite3 11 ABRT: ObjectWrap dtor → RemoveEnvironmentCleanupHook when env is nullptr. keep-until-listen was insufficient — post-listen GC during grok heap growth still ABRTs. Keep+reuse Statements (SQL-keyed Map) for the process lifetime. Do not disarm after listen.
- Grok 4.6 context is 500k with no text output limit. The adapter must omit context and max-output flags.
- max-turns by effort: medium 20, high 40, xhigh 60 (cap 100). Inbound email xhigh is 100 turns and 25 minutes (not 60/30). Timeout scales from the 10-minute baseline so 40/60 can finish (cap 30m). Not infinite. Take `ASMLTR_GROK_TIMEOUT_MS=600000` as that baseline.
- Do not port `ASMLTR_MAX_THINKING_TOKENS=4000`, opus, haiku, or `ASMLTR_MODEL`. Inherited Claude leftovers (engines fallback `claude`, runtime getModel opus, thinking 4000) are Claude-engine only.

## Our box only, skip

Do not merge these.

- `ASSISTANT_NAME=ivy`
- ivy stream slug
- `env.ivy.example` / `seed.ivy.example` branding
- osiris user systemd units (`asmltr-core` / `asmltr-collector` / `asmltr-manager`)
- `ivy.gtwy.net` and host nginx site files
- `mcp.ivy.gtwy.net` — public MCP connector so Adjutant can `ask` Ivy over HTTPS (no SSH).
  Instance `ivy-mcp`, bind `127.0.0.1:3018`, `base_url` https://mcp.ivy.gtwy.net.
  Site file: `extras/ivy-local/nginx/mcp.ivy.gtwy.net` (copy also in `/home/adjutant/nginx-ivy/`).
  Do not attach this host to `ivy.gtwy.net`. Dashboard keeps `/.well-known/oauth-*` on ivy.gtwy.net;
  MCP has its own origin. Clients file is gitignored (not in this commit). James: DNS + certbot after. Eve: skip.
- live `.env`, tokens, `ASMLTR_AUTH_SECRET`, insights token, `vault.pass`
- `docker-compose.local.yml`
- Authelia leftover notes (Authelia was removed)
- Email local policy (not the `\Seen` fix): `owner_forward_to` for unknown senders; known people on the trust store auto-send (`always_send` on that path). Do not take this as the upstream default — upstream stays `approval_policy`.
- `extras/ivy-local/` — Corona / Rolodex / OneNote stdio MCP wrappers for this host. Eve: skip. Register with `extras/ivy-local/register.sh` (`~/.asmltr/mcp.json` + `grok mcp add`).
- Corona: localhost `127.0.0.1:12701` only. Tools `corona_health`, `corona_recipe`, `corona_cigars`, `corona_cooking`. No `/say`.
- Cigar writeup: kektech `#cigars` first (who, when America/New_York 24-hour, what they said). Then a section headed exactly `Additional notes from the web`.
- Rolodex: Ivy chose the **two-file setup** (19 Aug 2026, localhost `asmltr ask`). `contacts.json` = daily Google dump. `aliases.json` = static nicknames the 07:30 sync must never overwrite. People cards stay relationship memory. Do not invent a third store.
- Ivy Rolodex cache: `~/.asmltr/rolodex-cache` (not Adjutant 08:00 `/home/box/rolodex-data`, not `/home/adjutant/rolodex`). Timer `ivy-rolodex-sync.timer` at **07:30 America/New_York**, `OnBootSec=3min`, `Persistent=true`. Source `127.0.0.1:12702/export`.
- Seeded aliases (case-insensitive; prefer alias hit): `jess` / `wife` → Jess Watt; `steve` → Steve Allison; `mom` / `eileen` / `mother` → Eileen Watt (also Eileen Miller); `joey` → Joey Kapolka. File mode 600, outside git (has resourceNames). A phone number is not permission to text. Voice/SMS parked.
- OneNote: `~/.asmltr/onenote/{token.json,.client.json}` already on the host, mode 600. Do not print. Tools `onenote_health`, `onenote_login`, notebooks/sections/pages/get/create/update.
- user unit `ivy-rolodex-sync.timer` / `ivy-rolodex-sync.service`
