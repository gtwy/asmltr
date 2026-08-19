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
- Live deltas: `onDelta` uses the same `joinText` as persist, not raw `+=`. Do not invent a space after `.!?`. Raw append glues `on.Yes` when a tool close is missed.
- Live list: past-idle no-pid web cards leave Live. `GET /api/sessions?active=1` excludes rows past `last_activity` + idle and flips those rows to `ended` on read. History stays. Do not show an Idle badge. Same session key can come back Active on a later message.
- Engines help: put CLI login commands on their own line so they do not wrap mid-flag.
- Dashboard nginx: `client_max_body_size 32m` (default 1m 413s Live attach). Live composer POSTs raw bytes to `/v2/upload` (same as recordings); core caps original files at 25MB. Host 80g is not enough if the container nginx is still 1m.
- Email: the IMAP watcher tracks a UID cursor and never set `\Seen`, so Gmail still looked unread after Ivy handled mail. After a message is actually handled (watch path), set `\Seen`. `asmltr mail read` marks seen by default (`--keep-unread` to peek). Skip self / noreply / bounce so security-alert mail can stay unread.
- Email: `asmltr send email … --cc "<addr>"` (comma-separated ok). Manager `/send` and the email connector `/out` pass `cc` through to SMTP.
- Email: persist the IMAP lastUid cursor per instance at `~/.asmltr/email-lastuid-<instanceId>.json`. On start, use it if present instead of `uidNext-1`. Advance lastUid (and write the file) only when `processMessage` returns `handled:true`. Do not bump on hang-up or failure — a naive restart otherwise skips the failed uid.
- Moderation: default OpenAI classifier (`gpt-5-nano`) is a reasoning model. Default omits `reasoning_effort` (API default) for security. Set `ASMLTR_MODERATION_REASONING_EFFORT=minimal` later for speed (uncapped ~2–3.5s). Knob still gpt-5-family only; empty/`off`/`none` omit. Logs include `duration_ms`.
- Backups must not open a second better-sqlite3 Database in the core process. Dashboard POST `/v2/backups` and the in-process scheduler spawn `node scripts/backup.js create` with `ASMLTR_BACKUP_CHILD=1` so sqlite runs in another isolate. CLI `node scripts/backup.js create` keeps the online-backup path.

## Take if you want Grok as an engine — not Ivy-only

Helps any site that runs the Grok CLI.

- `core/src/engines/grok.js` adapter
- Grok text tokens as live deltas without trim (mashed words if you trim or treat snapshots as appends)
- Never trim grok text tokens. Never invent spaces. Leading space is on the next streaming-json `data` token (`Here's` + ` a summary`). All channels.
- Always pass `--effort`. Baseline `ASMLTR_GROK_EFFORT` (Ivy: `medium`; unset still defaults `high` for other installs). Auto-`high` on lookup/research/Corona/Rolodex/troubleshooting. Auto-`xhigh` on git/code/deep-dive (implement, refactor, write/patch code, commit, PR, "deep dive"). HOME cwd is never a project. Never `process.cwd()`. Score the current user message only (`effortPrompt`) — not drainObserved/catch-up. One-shot next-effort still wins (including over inbound email); `complete()` skips auto-raise. Whole-word `+xh` / `+h` (start, end, or standalone — not inside other text) override to xhigh / high for this turn only when the sender is owner/bypass or their raw Discord id is in `ASMLTR_GROK_EFFORT_ELEVATE_IDS`. Honored token is stripped from `effortPrompt` and the grok user prompt; unknown senders keep the token and stay on the picker. Override wins over the three-tier picker (immediately after one-shot / explicit). Do not persist. No owner snowflake in git. Inbound email (`channel === "email"`) is always xhigh after that one-shot (100 turns). Watchdog is 60 minutes unless From is `james@techdirect.io` (case-insensitive, display-name wrapping ignored; that exact address only — not the domain, not other james@), then 4 hours. Interactive (discord, assistant-web, assistant-native, mcp): medium 5, high 10, xhigh 60 minutes. Other channels stay three-tier. Tight: do not treat bare "fix" as xhigh. Do not port last-effort inherit or a generic `XHIGH_CHANNELS` list.
- Engines copy: `grok login --device-auth` on its own line
- Finite idle as a grok-session feature (we default 30 minutes; the idea is reusable)
- Node 24 + better-sqlite3 11 ABRT: ObjectWrap dtor → RemoveEnvironmentCleanupHook when env is nullptr. keep-until-listen was insufficient — post-listen GC during grok heap growth still ABRTs. Keep+reuse Statements (SQL-keyed Map) for the process lifetime. Do not disarm after listen.
- Skip scheduled backup while a grok child is running (`~/.grok/bin/grok`). Do not bump `last_run` so the next ~10 min tick retries. Manual dashboard POST still runs (child spawn already keeps sqlite out of core).
- Grok 4.6 context is 500k with no text output limit. The adapter must omit context and max-output flags.
- max-turns by effort: medium 20, high 40, xhigh 60 (cap 100). Inbound email xhigh is 100 turns and 60 minutes, or 4 hours when From is `james@techdirect.io`. Interactive (discord / assistant-web / assistant-native / mcp) watchdog: medium 5 min, high 10 min, xhigh 60 min. Watchdog cap 4h so owner-from email can use it; interactive stays 5/10/60. Not infinite. Idle stays 30 minutes.
- Do not port `ASMLTR_MAX_THINKING_TOKENS=4000`, opus, haiku, or `ASMLTR_MODEL`. Inherited Claude leftovers (engines fallback `claude`, runtime getModel opus, thinking 4000) are Claude-engine only.

## Our box only, skip

Do not merge these.

- `ASSISTANT_NAME=ivy`
- ivy stream slug
- `env.ivy.example` / `seed.ivy.example` branding
- osiris user systemd units (`asmltr-core` / `asmltr-collector` / `asmltr-manager`)
- This install’s backup clock is 4:20 AM America/New_York (`hour=4` `minute=20` in `~/.asmltr/backup-schedule.json`). Due when local time is past 4:20 today and `last_run` is before today’s 4:20 — not a rolling `every_hours` catch-up on boot.
- `ivy.gtwy.net` and host nginx site files
- `mcp.ivy.gtwy.net` — public MCP connector so Adjutant can `ask` Ivy over HTTPS (no SSH).
  Instance `ivy-mcp`, bind `127.0.0.1:3018`, `base_url` https://mcp.ivy.gtwy.net.
  Site file: `extras/ivy-local/nginx/mcp.ivy.gtwy.net` (copy also in `/home/adjutant/nginx-ivy/`).
  Do not attach this host to `ivy.gtwy.net`. Dashboard keeps `/.well-known/oauth-*` on ivy.gtwy.net;
  MCP has its own origin. Clients file is gitignored (not in this commit). James: DNS + certbot after. Eve: skip.
- live `.env`, tokens, `ASMLTR_AUTH_SECRET`, insights token, `vault.pass`, live `ASMLTR_GROK_EFFORT_ELEVATE_IDS` snowflakes
- `docker-compose.local.yml`
- Authelia leftover notes (Authelia was removed)
- Email local policy (not the `\Seen` fix): `owner_forward_to` for unknown senders; known people on the trust store auto-send (`always_send` on that path). Do not take this as the upstream default — upstream stays `approval_policy`.
- Ops desk (19 Aug 2026): inbox-alert tickets in Self silo `memory/ops/`. Microsoft Entra / Synchronization noreply is allowed through via `memory/ops/allowthrough.json` (connector otherwise skips noreply). Automated senders still never get a reply. Tim Cao + Joey Kapolka are trust-store principals so their mail is a live turn. Weekday 07:00 ET schedule `ops-desk-morning-sweep` sends the one allowed follow-up (Entra / Barracuda / microsoft-other). Microsoft card-declined follow-up is weekday 08:00 ET (`ops-desk-invoice-declined-sweep`), every 2 business days, until James closes. Other `@microsoft.com` mail: noise → no reply; action-needed → staff, ticket if warranted. Card declined with no matching invoice: ticket, staff only, do not contact customers. Do not handle a new alert *type* until James and Ivy add a workflow file.
- `extras/ivy-local/` — Corona / Rolodex / OneNote stdio MCP wrappers for this host. Eve: skip. Register with `extras/ivy-local/register.sh` (`~/.asmltr/mcp.json` + `grok mcp add`).
- Corona: localhost `127.0.0.1:12701` only. Tools `corona_health`, `corona_recipe`, `corona_cigars`, `corona_cooking`. No `/say`.
- Cigar writeup: kektech `#cigars` first (who, when America/New_York 24-hour, what they said). Then a section headed exactly `Additional notes from the web`.
- Rolodex: Ivy chose the **two-file setup** (19 Aug 2026, localhost `asmltr ask`). `contacts.json` = daily Google dump. `aliases.json` = static nicknames the 07:30 sync must never overwrite. People cards stay relationship memory. Do not invent a third store. Writes (19 Aug 2026): `rolodex_create` / `rolodex_add_phone` / `rolodex_delete` go live to `127.0.0.1:12702` then update that row in `contacts.json`. Need People API scope `contacts` (write), not only `contacts.readonly`.
- Ivy Rolodex cache: `~/.asmltr/rolodex-cache` (not Adjutant 08:00 `/home/box/rolodex-data`, not `/home/adjutant/rolodex`). Timer `ivy-rolodex-sync.timer` at **07:30 America/New_York**, `OnBootSec=3min`, `Persistent=true`. Source `127.0.0.1:12702/export`. Daily copies of `contacts.json` in `~/.asmltr/rolodex-cache/backups/` (max 5, first snapshot of the ET day wins). Not a third lookup store. `rolodex_restore` recreates one My Contact from a copy; do not bulk-push the dump.
- Seeded aliases (case-insensitive; prefer alias hit): `jess` / `wife` → Jess Watt; `steve` → Steve Allison; `mom` / `eileen` / `mother` → Eileen Watt (also Eileen Miller); `joey` → Joey Kapolka. File mode 600, outside git (has resourceNames). A phone number is not permission to text. Voice/SMS parked.
- OneNote: `~/.asmltr/onenote/{token.json,.client.json}` already on the host, mode 600. Do not print. Tools `onenote_health`, `onenote_login`, notebooks/sections/pages/get/create/update.
- user unit `ivy-rolodex-sync.timer` / `ivy-rolodex-sync.service`
