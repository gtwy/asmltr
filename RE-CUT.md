# Eve recut (public-shaped) — 2026-08-31

Worktree only. Do not apply host cutover. Live product stays on `ivy` /
ivy-local `main`. Public persona examples stay Gaia. Host identity stays
the configured `ASSISTANT_NAME`.

## Public product

- Stop: anyone may abort a processing turn. Overlay wraps `abort-allow` and
  `/v2/abort` back to starter-or-owner.
- Who + surface live in `trust.resolve` (connector sets `envelope.public`
  only). Product owner-always-bypass on unspoofable principal id `owner`.
  Grants may narrow `*` on a public surface. Overlay owner-lock still
  restricts public Discord even with bypass.
- `shared/tool-policy.js` is media/code allowlists + deny-env, not a second
  capability plane. Overlay wraps `isRestricted` / `policyFor` for V31.
- Discord connector is I/O. No trust-principal polling to re-derive policy.
  PII gate default off; whole-reply drop is nuclear. Overlay pins trust-store
  + whole-reply drop.
- Send is `asmltr send` + fuzzy name resolver. No parallel MCP `asmltr_guild_post`.
  Overlay keeps confirm / on-behalf-of / same-guild.
- Path deny-list (`.ssh` / vault / silos / `.env` / sqlite / 25MB / realpath)
  stays overlay. Public attach-stage remains a thin staging wrap.
- Settings: PII off, attachments `all_files`, thought chips off, temp GC
  opt-in on public callers. Overlay `host-settings.json` pins live host
  behavior. Do not edit running host config.

## Overlay first

`overlay/eve-20260831` must be loaded from ivy-local `core-entry.js` before
this public branch is ever fast-forwarded. See ivy-local `overlay/README.md`.
