# Ivy

This branch is Ivy/Grok on the **gtwy/asmltr** fork. We never push to jarethmt/asmltr.

Eve: pull `ivy` into your `main` if you want pieces. Merge FROM `gtwy/asmltr` `ivy` INTO `jarethmt/asmltr` `main` — pick what you take.

## Take these if you want them

Upstream-worthy, engine-agnostic:

- **Per-turn silo write + last-topics inject on a fresh session.** Not a session-close flush.
- **SSE leftover flush when the reader closes.** A done frame without trailing newlines still fires `onDone`.
- **Dashboard nginx `/v2/`:** `proxy_buffering off`, `proxy_cache off`, `gzip off`, HTTP/1.1. SSE + gzip stalls without this.
- **Engine text tokens as live deltas without trim.** Grok or any engine. Trim, or treat snapshots as appends, and words mash together.
- **SessionDetail: autoscroll the inner transcript pane**, not the modal/page. `applySegment` must match stored outbound.
- **Engines help:** put CLI login commands on their own line so they do not wrap mid-flag.

## Ivy-specific, skip unless you want Grok

- `grok.js` engine
- `--effort high` / auto-xhigh on code
- idle default 30 minutes
- `env.ivy.example`, `seed.ivy.example`
- osiris user systemd units (core / collector / manager)
- ivy stream slug
- `grok login --device-auth` copy

## Do not take

- live `.env`
- tokens / `ASMLTR_AUTH_SECRET` / insights token
- `vault.pass`
- `docker-compose.local.yml`
- host nginx / ivy.gtwy.net site files
- Authelia leftover notes (Authelia was removed; built-in `ASMLTR_AUTH` is live-only)
