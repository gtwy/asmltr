# Changelog

All notable changes to asmltr are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and asmltr uses [Semantic Versioning](https://semver.org/).

Releases are git tags `vX.Y.Z`. The `stable` update channel tracks the latest tag; the `edge`
channel tracks `origin/main`. See [docs/UPDATER-DESIGN.md](docs/UPDATER-DESIGN.md).

## [Unreleased]

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
