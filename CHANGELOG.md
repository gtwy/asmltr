# Changelog

All notable changes to asmltr are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and asmltr uses [Semantic Versioning](https://semver.org/).

Releases are git tags `vX.Y.Z`. The `stable` update channel tracks the latest tag; the `edge`
channel tracks `origin/main`. See [docs/UPDATER-DESIGN.md](docs/UPDATER-DESIGN.md).

## [Unreleased]

### Added
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
