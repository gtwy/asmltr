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
- Email local policy (not the `\Seen` fix): `owner_forward_to` for unknown senders; known people on the trust store auto-send (`always_send` on that path). Do not take this as the upstream default — upstream stays `approval_policy`.
- `extras/ivy-local/` — osiris-only Corona / Rolodex / OneNote stdio MCP wrappers. Eve: skip. Localhost only (`127.0.0.1:12701` Corona, `127.0.0.1:12702` Rolodex). Register with `extras/ivy-local/register.sh` (`~/.asmltr/mcp.json` + `grok mcp add`). Not asmltr core. Do **not** enable Corona `/say` for Ivy.
- Cigar writeup: lead with kektech `#cigars` (who, when in America/New_York 24-hour, what they said). Then a section headed exactly `Additional notes from the web`. Corona is keyword-dumb, newest-first.
- Ivy Rolodex cache: `~/.asmltr/rolodex-cache/` (not `/home/adjutant/rolodex`, not Adjutant’s 08:00 box cache at `/home/box/rolodex-data`). Daily `systemd --user` `ivy-rolodex-sync.timer` at **07:30 America/New_York** (`OnCalendar` + `OnBootSec` + `Persistent=true`). Sync writes **only** `contacts.json` from `GET /export`. Never overwrite `aliases.json`.
- Ivy aliases (seeded if missing, never clobbered): `mom` / `eileen` / `mother` → Eileen Watt (also Eileen Miller, `eileen@gtwy.net`); `wife` / `jess` → Jess Watt (`jk@gtwy.net`); `joey` → Joey Kapolka; `steve` → Steve Allison. Prefer the obvious display-name match.
- OneNote (Ownership Notebook): `extras/ivy-local/onenote/` talks Graph if osiris-local creds exist at `~/.asmltr/onenote/{.client.json,token.json}` mode 600. Do not copy or invent tokens. Do not commit those files.
- `~/.asmltr/mcp.json` corona / rolodex / onenote entries and user unit `ivy-rolodex-sync.timer` / `ivy-rolodex-sync.service`.
