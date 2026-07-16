# Changelog

All notable changes to asmltr are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and asmltr uses [Semantic Versioning](https://semver.org/).

Releases are git tags `vX.Y.Z`. The `stable` update channel tracks the latest tag; the `edge`
channel tracks `origin/main`. See [docs/UPDATER-DESIGN.md](docs/UPDATER-DESIGN.md).

## [Unreleased]

### Added

### Changed

### Fixed

## [0.4.0] - 2026-07-16

### Added

### Changed

### Fixed

## [0.4.0] - 2026-07-15

### Added
- **Aesthetic identity facets** — a free-text *aesthetic* sensibility + an ordered *signature palette*
  (primary/secondary/tertiary; names and/or hex), injected into the anchor every session sees, so an
  agent leans on its own colors/style when building assets and no other cue is given. Editable in
  Settings → Identity (GUI + TUI via the manifest).
- **Live UI theming from the palette** — the dashboard's brand accent, gradients, background glow,
  pills, **nav logo** (now inline SVG), and **browser tab favicon** (regenerated data-URI) all retint
  in real time when the signature palette is saved. Falls back to the built-in violet/pink.
- **Discord server invite + membership management** — a *Servers* button on the Discord instance card
  opens a modal with the copyable OAuth invite URL (to add the bot to a new server) and the list of
  servers it's in, each with a *Leave* button. New connector `/servers` control endpoint + manager
  proxy generalization; documented in `docs/connectors/discord.md`.

### Fixed
- **Self-goal extractor no longer gives up** (issue #16) — the reflector now climbs to the loosest
  honest through-line (shared subject/domain/mode/direction; a single part's aim *is* the goal)
  instead of defaulting to "no single goal — the parts are unrelated," which is now a rare last resort.

## [0.3.1] - 2026-07-15

### Added

### Changed
- **Standardized on Node 24 LTS** (issue #21). `engines.node` raised to `>=24.0.0` across the root +
  every workspace, a root `.nvmrc` pinning `24`, and the dashboard build image bumped
  `node:20-alpine → node:24-alpine`. Clears the `EBADENGINE` from `@discordjs/voice@0.19.2`
  (needs `>=22.12`); docs updated from ">= 18".
- **Turn-complete notification toggle moved to Settings → Notifications.** The sidebar header no
  longer carries the toggle; it lives in a GUI-only Settings tab (with permission state + a link to
  the history page). The ✦ Notifications nav item still shows notification history.

### Fixed
- **Documented `ASMLTR_UPDATE_MANAGED` in `.env.example`** (issue #23) — the managed-mode work (#18)
  added the variable but not the example entry CLAUDE.md calls for.

## [0.3.0] - 2026-07-15

### Added
- **Persistent update progress (GUI + TUI).** The updater writes `~/.asmltr/update-status.json`
  through every phase (fetch → install → restart → verify); core exposes `GET /v2/update/progress`.
  The GUI shows a persistent progress panel at the top of every page that survives the mid-update
  service restart (spinner, phase, log tail, terminal result + dismiss); the TUI shows a matching
  overlay reading the status file directly. Triggered from both the banner and Settings → Updates.
- **Agent-name brand + browser tab title.** The header shows the configured agent name with an
  "asmltr control plane" subtext; the running version sits by the collector-live pill; the tab title
  is `<Agent> · <focused session, else active view>`.
- **claude-code sessions now show the assistant's replies.** The connector recovers the reply from
  the transcript on the `Stop` hook and emits it as an `outbound` event (previously only inbound/tool
  events reached the dashboard). Requires wiring the `Stop` hook (README updated).
- **Committed lockfile + `npm ci`** (issue #17): a root `package-lock.json` pins the whole transitive
  tree (incl. native modules); the updater prefers `npm ci` (exact-match) with an `npm install` fallback,
  and `release.js` regenerates the lock per tag so every release ships a matching lock.
- **Externally-managed update mode** (issue #18): `ASMLTR_UPDATE_MANAGED=<manager>` / a `~/.asmltr/managed`
  flag makes the updater step aside cleanly (distinct exit code 6, `getUpdateStatus.managed`,
  `/v2/update/run` refuses) on package/image/config-managed installs instead of crash-looping.
- **The cast (Access-evolution Phase 0)** — the identity/relationship layer, built on the existing
  trust store (no second store). New `principal_profile` (who a member is + how to relate), pairwise
  directional `relationships`, per-scope `engagement` (engage|observe|ignore, retiring per-connector
  bot lists), and `verification_strength` on identifiers. `resolve()` now returns a member's profile,
  ALL cross-channel identities, the self→them relationship, and engagement policy. `buildRelationshipPrompt`
  injects into the system prompt: who you're talking to, their **cross-channel identity** (one person
  across all their channels), your relationship, and the peer agents present (recognition without
  per-channel config). `/trust/{profiles,relationships,engagement}` endpoints. Roadmap: docs/ACCESS-EVOLUTION.md.
- **Cross-session send with assimilation** (`POST /v2/send`, channel-agnostic). An agent in any
  session can post into another channel AND the destination session folds the message into its own
  context (it was posted under its name from a parallel session). Connectors' `/out` now return the
  destination `conversation_key` (Discord + Telegram) so core can route the assimilation. `asmltr send`
  goes through core (falls back to the manager if core is down).

### Fixed
- **Multi-agent no-reply reliability.** When the model decides a message isn't for it, it should emit
  the bare `[[NO_REPLY]]` token — but it often prose-refuses instead ("That's addressed to Moneo, not
  me…"), which got posted as spam. Core now detects that short meta-refusal and stays silent (channel-
  agnostic; length-capped + adjacency-specific to avoid suppressing real replies that merely mention
  who a message was addressed to).
- **Discord reply threading.** A message that uses Discord's reply feature now carries "↩ in reply to
  <author>: …" into the prompt (both addressed and observed paths), so in a busy multi-agent channel
  the agent can tell WHAT a peer replied to instead of losing the reference.
- **Interrupted / empty turns no longer emit a canned greeting.** An empty reply (interrupt,
  tool-only turn, or a deliberate non-answer) now posts nothing instead of "I'm here — what would
  you like to know?", which on multi-agent channels was noise other agents kept answering.
- **Multi-agent self/other attribution.** The observed-activity catch-up now states that other
  participants' "I/my" refers to the named speaker (not the reading agent), and the Discord identity
  line tells the agent its own handle — so an agent stops mistaking peers' first-person messages, or
  its own earlier ones, for something newly said to it.

### Added
- **Full-autonomy terminal sessions**: `asmltr claude` (and dashboard takeovers) launch in
  bypass-permissions mode by default (`--permission-mode bypassPermissions` + `IS_SANDBOX=1`).
  GUI/TUI-toggleable via Settings → Runtime and `/v2/runtime/cli-permission-mode`.
- **Downloadable artifacts in chat**: the GUI auto-detects local file paths in an assistant's reply
  and renders a download chip that streams the file through `GET /v2/file` (Authelia-gated).

## [0.2.0] - 2026-07-15

First deterministic-updater release: LLM-free versioned self-update, pinned releases, stable/edge channels, self-healing setup steps.

### Added
- **Deterministic installer + updater** (no LLM on the happy path): `scripts/update.js` runs the
  full update as a scripted, verified pipeline (fetch → resolve channel target → setup-steps →
  npm install → dashboard build → restart-with-rollback → announce). The agent-driven updater
  remains only as an escape hatch when the deterministic path fails.
- **Semantic versioning + pinned releases**: `VERSION`, this changelog, git tags, and a `scripts/release.js`
  release cutter. Services report `{ version, channel, sha }` from `/version`.
- **Self-healing setup steps**: `setup.d/` numbered idempotent steps + an applied-ledger, so a
  bespoke install picks up any newly-required install step on its next update.
- **Update channels**: `stable` (latest release tag) vs `edge` (origin/main), selectable per install.

## [0.1.0] - 2026-07-15
- Baseline: the pre-versioning state of asmltr (core pipeline, connectors, insights dashboard + TUI,
  shared console manifest, unified speech layer, PWA). First tagged release.
