# Ivy

`ivy` is Grok/Ivy on the `gtwy/asmltr` fork. We never push to `jarethmt/asmltr`. Eve: pull `ivy` into your `main` if you want pieces.

## Take for every asmltr install

Engine-agnostic. Worth taking even if you never run Grok.

- Per-turn Self silo write + last-topics inject on a fresh session (not a session-close flush). jarethmt #128.
- SSE leftover flush when the reader closes, so a `done` frame without trailing newlines still fires `onDone`. jarethmt #129.
- Dashboard nginx `/v2/`: `proxy_buffering off`, `proxy_cache off`, `gzip off`, HTTP/1.1. SSE + gzip stalls. jarethmt #129.
- SessionDetail: autoscroll the inner transcript pane (FloatingWindow), not the modal or the page. jarethmt #129.
- `applySegment` must match stored outbound (replace growing snapshots; append only real deltas; do not trim). jarethmt #129.
- Web live: keep the last finished block, not a longer status/narration mash. Discord already did this. Stream `onTool` must map to `onToolCall` so the draft block closes; otherwise onDone keeps the glued longer text. jarethmt #129.
- Live deltas: `onDelta` uses the same `joinText` as persist, not raw `+=`. Do not invent a space after `.!?`. Raw append glues `on.Yes` when a tool close is missed. jarethmt #129.
- Live list: past-idle no-pid web cards leave Live. `GET /api/sessions?active=1` excludes rows past `last_activity` + idle and flips those rows to `ended` on read. History stays. Do not show an Idle badge. Same session key can come back Active on a later message. jarethmt #129.
- Engines help: put CLI login commands on their own line so they do not wrap mid-flag.
- Dashboard nginx: `client_max_body_size 32m` (default 1m 413s Live attach). Live composer POSTs raw bytes to `/v2/upload` (same as recordings); core caps original files at 25MB. Host 80g is not enough if the container nginx is still 1m. jarethmt #129.
- Email: the IMAP watcher tracks a UID cursor and never set `\Seen`, so Gmail still looked unread after Ivy handled mail. After a message is actually handled (watch path), set `\Seen`. `asmltr mail read` marks seen by default (`--keep-unread` to peek). Skip self / noreply / bounce so security-alert mail can stay unread. jarethmt #121.
- Email: `asmltr send email … --cc "<addr>"` (comma-separated ok). Manager `/send` and the email connector `/out` pass `cc` through to SMTP. jarethmt #125.
- Email: persist the IMAP lastUid cursor per instance at `~/.asmltr/email-lastuid-<instanceId>.json`. On start, use it if present instead of `uidNext-1`. Advance lastUid (and write the file) only when `processMessage` returns `handled:true`. Do not bump on hang-up or failure — a naive restart otherwise skips the failed uid. jarethmt #124.
- Email: IMAP probe reconnects when the handle is dead (`!imap` / `!usable`); `connectImap` logs, clears the handle, and retries in ~10s if not stopped (connecting flag + one timer so retries do not stack). After `fetchNew` clears `busy`, an extra fetch pass runs when more UIDs exist so an EXISTS that arrived while busy is not dropped. Connection-class fetch errors (`Connection not available`, not connected, socket, closed, timeout) `close()` so the close handler reconnects. jarethmt #126.
- Moderation: default OpenAI classifier (`gpt-5-nano`) is a reasoning model. Default omits `reasoning_effort` (API default) for security. Set `ASMLTR_MODERATION_REASONING_EFFORT=minimal` later for speed (uncapped ~2–3.5s). Knob still gpt-5-family only; empty/`off`/`none` omit. Logs include `duration_ms`. jarethmt #122.
- Backups must not open a second better-sqlite3 Database in the core process. Dashboard POST `/v2/backups` and the in-process scheduler spawn `node scripts/backup.js create` with `ASMLTR_BACKUP_CHILD=1` so sqlite runs in another isolate. CLI `node scripts/backup.js create` keeps the online-backup path. jarethmt #127.

## Take if you want Grok as an engine — not Ivy-only

Helps any site that runs the Grok CLI.

- MCP asks (`channel === "mcp"`) always xhigh from the first grok spawn (after one-shot), 60-minute watchdog. Same idea as inbound email xhigh; not the owner-from 4h path. Eve: take.
- `core/src/engines/grok.js` adapter. jarethmt #130.
- Grok text tokens as live deltas without trim (mashed words if you trim or treat snapshots as appends)
- Never trim grok text tokens. Never invent spaces. Leading space is on the next streaming-json `data` token (`Here's` + ` a summary`). All channels.
- Always pass `--effort`. Baseline `ASMLTR_GROK_EFFORT` (Ivy: `medium`; unset still defaults `high` for other installs). Auto-`high` on lookup/research/Corona/Rolodex/troubleshooting. Auto-`xhigh` on git/code/deep-dive (implement, refactor, write/patch code, commit, PR, "deep dive") and on consecutive phrases `generate an image` / `generate image` / `generate a photo` / `generate photo` (that order only — not bag-of-words). HOME cwd is never a project. Never `process.cwd()`. Score the current user message only (`effortPrompt`) — not drainObserved/catch-up. One-shot next-effort still wins (including over inbound email); `complete()` skips auto-raise. Whole-word `+xh` / `+h` (start, end, or standalone — not inside other text) override to xhigh / high for this turn only when the sender is owner/bypass or their raw Discord id is in `ASMLTR_GROK_EFFORT_ELEVATE_IDS`. Honored token is stripped from `effortPrompt` and the grok user prompt; unknown senders keep the token and stay on the picker. Override wins over the three-tier picker (immediately after one-shot / explicit). Do not persist. No owner snowflake in git. Inbound email (`channel === "email"`) is always xhigh after that one-shot (100 turns). Watchdog is 60 minutes unless From matches `ASMLTR_OWNER_FROM_EMAIL` (case-insensitive, display-name wrapping ignored; that exact address only — not the domain). Then 4 hours. Do not put a real address in git. MCP asks (`channel === "mcp"`) are always xhigh from the first grok spawn (after one-shot), 60-minute watchdog — same idea as inbound email xhigh, not the owner-from 4h path. Interactive (discord, assistant-web, assistant-native): medium 5, high 10, xhigh 60 minutes. Other channels stay three-tier. Tight: do not treat bare "fix" as xhigh. Do not port last-effort inherit or a generic `XHIGH_CHANNELS` list. jarethmt #131.
- Engines copy: `grok login --device-auth` on its own line
- Finite idle as a grok-session feature (we default 30 minutes; the idea is reusable). jarethmt #131.
- Node 24 + better-sqlite3 11 ABRT: ObjectWrap dtor → RemoveEnvironmentCleanupHook when env is nullptr. keep-until-listen was insufficient — post-listen GC during grok heap growth still ABRTs. Keep+reuse Statements (SQL-keyed Map) for the process lifetime. Do not disarm after listen.
- Skip scheduled backup while a grok child is running (`~/.grok/bin/grok`). Do not bump `last_run` so the next ~10 min tick retries. Manual dashboard POST still runs (child spawn already keeps sqlite out of core).
- Grok 4.6 context is 500k with no text output limit. The adapter must omit context and max-output flags.
- max-turns by effort: medium 20, high 40, xhigh 60 (cap 100). Inbound email xhigh is 100 turns and 60 minutes, or 4 hours when From matches `ASMLTR_OWNER_FROM_EMAIL`. MCP is always xhigh / 60 minutes (not 4h). Interactive (discord / assistant-web / assistant-native) watchdog: medium 5 min, high 10 min, xhigh 60 min. Watchdog cap 4h so owner-from email can use it; interactive stays 5/10/60. Not infinite. Idle stays 30 minutes.
- Do not port `ASMLTR_MAX_THINKING_TOKENS=4000`, opus, haiku, or `ASMLTR_MODEL`. Inherited Claude leftovers (engines fallback `claude`, runtime getModel opus, thinking 4000) are Claude-engine only.

## Not in this repo

This repository is **public**. Do not commit personal names (household, family, staff), emails, phones, Discord snowflakes, internal hostnames, live vhosts, home-directory paths, per-box bind ports, backup clocks, or other install-specific layout. Those belong in `CLAUDE.local.md` (gitignored), the live `.env`, or the Self silo — never in a file that gets pushed.
