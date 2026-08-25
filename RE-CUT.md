# Gaia recut (public-shaped) — 2026-08-25

Draft only. Do not apply host cutover today. Live product stays on `ivy` /
`ivy-local` main. This file lives on `recut/gaia-20260825` in the
`asmltr-recut` worktree.

## What was scrubbed

Public-facing example / fixture / help text that used the private assistant
identity is now Gaia (or a generic assistant name):

- Example env: `ASSISTANT_NAME=gaia` in `.env.example` and `env.gaia.example`
  (renamed from `env.ivy.example`). Host-shaped seed example renamed
  `seed.ivy.example.json` → `seed.gaia.example.json`. Comments note that
  the live host stays ivy via off-git config.
- `scripts/apply-user-units.sh` example banners / `ASSISTANT_NAME` check → gaia,
  and copies `env.gaia.example` / `seed.gaia.example.json`. Comment that the
  live host stays ivy via off-git config. Does not edit live systemd.
- `core/ecosystem.config.js` points at `env.gaia.example`.
- `test/example-configs.test.js` locals `ivy` / `ivyFriend` / `ivyEnv` →
  `gaia` / `gaiaFriend` / `gaiaEnv`, loading the renamed example files.
- CLI help: "ivy local chat" / "local ivy REPL" / "talk to ivy" → gaia.
  Local-chat banner reads `process.env.ASSISTANT_NAME` (default `gaia`).
- Docs: `docs/cli.md` `(ivy: grok)` → `(gaia: grok)`.
- CHANGELOG unreleased line: "Example configs for ivy" → gaia; filenames
  updated to `env.gaia.example` / `seed.gaia.example.json`.
- Tests: `Ivy Hedera` → `Gaia` (no surname); assistant mailbox fixtures →
  `assistant@example.com`; remaining install mailboxes in
  `email-owner-cc.test.js` → `owner@example.com` / `other@example.com`.
  Prompt-leak `(Ivy)` / `IvyBot` → Gaia, GitHub `workingPlaceholder('Gaia')`,
  upload caption `gaia what is this`, and effort-classifier `Hi Gaia`.
- `extras/ivy-local/rolodex` comments "Ivy's cache" / "Ivy Rolodex" → Gaia
  / assistant cache. Directory name unchanged.
- `shared/step-public.js` LANGUAGE_OVERLAP: dropped the `'ivy'` token
  (list is now rose/daisy plus the other common-word surnames). Not a
  special-case keep. No live PII classifier wired.

## Running-code now uses ASSISTANT_NAME

`core/src/server.js` `persistAskTurn` resolves the stream slug from
`process.env.ASSISTANT_NAME` (safe default `gaia`, not a private identity).
The leftover hardcoded fallback `streams.get('ivy')` is removed. If no
stream exists for the configured name, one is created under that name.

A live process that still has off-git `ASSISTANT_NAME=ivy` keeps the ivy
stream. Example files and the code default now say `gaia`.

CLI local-chat banner uses `process.env.ASSISTANT_NAME` (default `gaia`).

Connectors / identity / wake-word already used `ASSISTANT_NAME`.

## extras/ivy-local folder name kept on purpose

The directory, `register.sh` `IVY`/`IVY_LOCAL` locals, example systemd unit
names (`ivy-rolodex-sync.*`), and `mode: "ivy-cache"` stay. Those are
host-shaped extras paths, not the public product persona. Do not rename
the folder in this recut.

## What still must move to overlay vs stay in public asmltr

Leave implementations in this tree for now. They should become overlay later
(private `ivy-local`, not a public asmltr PR):

- **tool-policy** (`shared/tool-policy.js` + host `~/.asmltr/tool-policy.json`)
- **outbound-stage** (`shared/outbound-stage.js`) — destination is overlay,
  not main/public asmltr
- **stop** (`connectors/types/discord/abort-allow.js` + voice stop)
- **guild_post** (CLI/MCP/discord kind + Access-card copy) — public verb is send

Draft overlay modules live on `overlay/gaia-20260825` in ivy-local-recut:

- `owner-public-lock.js` — `classifyChannel(kind)` / `personaFor(kind)`
  (owner/dm → private; public/guild → Gaia)
- `grok-deny-from-forbidden.js` — `matchDeny(text, list)` (default list empty)
- `stop-starter-or-owner.js` — `canAbort({ speakerId, starterId, ownerId })`
- `trusted-role-migration.js` — DRY-RUN print only; refuse unless `DRY_RUN=1`

Do not live-wire those moves today.

## guild_post → send (public verb is send)

The public product verb is **`asmltr send`**. `guild_post` /
`asmltr guild-post` / MCP `asmltr_guild_post` is a same-server Discord
posting path that still lives in the public tree. It should not be the
word the public product talks about.

Still in this tree today (do not rename in this chunk — record only):

- CLI: `cli/asmltr.js` `kind: 'guild_post'`
- Connector: `connectors/types/discord/index.js` `kind === 'guild_post'`
- MCP: `mcp/toolbelt-server.js` `asmltr_guild_post`
- Prompt: `shared/toolbelt-prompt.js` advertises `asmltr guild-post`
- Tests: `test/guild-post.test.js`, `test/toolbelt-deny.test.js`
- Docs: `docs/cli.md`, `docs/connectors/discord.md`,
  `docs/coordination/cross-channel.md`, `docs/security/trust.md`,
  `INSTALL-WITH-AGENT.md` still teach `guild-post` as a separate verb
  because public Discord denies cross-channel `asmltr send`

What still must move to overlay (private ivy-local, not a public asmltr PR):

- The `guild_post` kind and MCP/toolbelt copy — host-only same-guild post
- Access-card (tier 1–5) gate that exists only to unlock that path
- Docs/prompt that present `guild-post` as a product verb; public docs
  should keep talking about `asmltr send`

Leave the implementations in this tree for now. Overlay later. Do not
live-wire today.

## Draft public vs private persona (do not live-wire)

| Plane | Name | Where |
| --- | --- | --- |
| Public product | Gaia (no surname) | this recut tree, example env, fixtures, help |
| Live host identity | Ivy | off-git config (`ASSISTANT_NAME`, identity.md, systemd). Unchanged today. |

Rules for the public tree:

- No Hedera / no surname.
- No `example.com` assistant mailbox. Fixtures use `assistant@example.com`
  (or `owner@example.com` when the mailbox is clearly the owner).
- Do not copy `~/.asmltr/identity.md`, `mcp.json`, `.env`, `trust.db`,
  `*env`, systemd units, or `email-authserv.json` into git.

## Left on purpose

- `test/update-ref.test.js` git branch fixture `ivy` / `origin/ivy`
  (git branch name, not assistant name)
- `extras/ivy-local/**` path, `register.sh` `IVY` var, systemd unit names,
  `mode: "ivy-cache"`
- Eve-as-reviewer (`Eve: skip extras/ivy-local...`)
- CHANGELOG historical Eve stories; Discord comments about past Eve
  behavior; `eve-assistant-web` legacy channel id
- `test/realtime-stt.test.js` "Eve what is the weather" wake-word fixture
- `test/engine-grok-effort.test.js` catch-up speaker `Eve:`
- `test/admin-alert.test.js` display_name `Eve'; id`
- `docs/ROADMAP-RECORDER-CONTEXTBANKS.md` "Eve observes calls"
- `guild_post` / `asmltr guild-post` implementation and tests (move later;
  public tree should talk about `send`)
- git commit messages (not edited)
- No Dionysus hits in this tree
- LANGUAGE_OVERLAP no longer special-cases `'ivy'` (token dropped). PII
  classify-then-redact is later; no live classifier wired.

## Do not apply host cutover today

Do not bounce. Do not checkout live `ivy` / `ivy-local` main. Do not push
`ivy` or `main`. Do not edit live systemd or off-git config. Fast-forward
cutover is a later step; see ivy-local `CONFIG-MIGRATION.md`.
