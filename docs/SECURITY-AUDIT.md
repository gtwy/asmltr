# Dependency security audit (triage)

Snapshot of `npm audit` against the host workspaces (`core`, `connectors`, `cli`,
`insights/collector`), with each advisory triaged by exposure and fix status. This
records what is known and why it is or is not actionable, so `npm audit` output is
managed rather than ignored. Update it when the tree or the advisories move.

## Snapshot

18 advisories: 1 critical, 9 high, 7 moderate, 1 low. Measured with `npm audit` on
the merged dependency tree. Note the host runtime floor is Node 24 (`engines`);
these counts were taken under Node 20, so re-confirm on Node 24.

The important finding: `npm audit fix` (non-breaking) clears essentially nothing
(it rewrites the whole lockfile to resolve one low-severity item). The critical and
most highs have no compatible fixed version available today; the rest need major
version bumps of parents that the 43-test suite does not exercise. So there is no
safe one-shot remediation. This file is the map for doing it deliberately.

## By fix status

### A. Compatible fix exists (apply on the next clean lockfile regen)

| Package | Severity | Vulnerable | Fixed | Source / note |
|---|---|---|---|---|
| `undici` | high | `<=6.26.0` (installed 6.24.1) | `6.28.0` (within `^6`) | HTTP-client set-cookie header injection. `6.28.0` satisfies `discord.js`'s `^6` pin, so an `overrides` entry applies it without a major bump. |
| `xml2js` | moderate | `0.4.23` | `0.6.2` | Via `blessed-contrib` → `map-canvas`. `0.6.2` is a `0.x` bump; verify `map-canvas` parsing still works. |

These two need a full `node_modules` + lockfile regeneration to take effect;
an incremental `npm install` with `overrides` does not re-resolve them.

### B. Needs a breaking major bump (feature-test before applying)

| Package | Severity | Fixed at | Exercised by tests? | Risk |
|---|---|---|---|---|
| `@modelcontextprotocol/sdk` | high | `1.30.0` (major) | no | Runtime-relevant (MCP servers, DNS-rebinding protection). Bump + test MCP provisioning across engines. |
| `blessed-contrib` | high | `4.8.13` (major) | no | The TUI dashboard. Bumping it is the only path that clears its `lodash`, `xml2js`, and `map-canvas` sub-advisories. Test the TUI by hand. |
| `uuid` | moderate | `14.0.1` (major) | no | v14 is ESM-first; confirm every `require('uuid')` call site still resolves. |

### C. No fix available (blocked upstream)

| Package | Severity | Vulnerable range | Why blocked |
|---|---|---|---|
| `tar` | critical | `<=7.5.20` | Hardlink path-traversal. Every released `tar` is in range, so there is no fixed version to move to. Reached only through `@discordjs/voice` → `@discordjs/opus` → `@discordjs/node-pre-gyp` → `tar` (install-time extraction of prebuilt native audio binaries). |
| `@discordjs/node-pre-gyp`, `@discordjs/opus`, `@discordjs/voice`, `prism-media` | high | (chain) | All stem from the unfixed `tar` above; they clear when `tar` gets a fix or the voice stack is dropped. |
| `lodash` | high | `<=4.17.23` | `_.template` code injection. `4.17.21` is the latest release and is in range; upstream has no patched version. Reached via `blessed-contrib`. |
| `brace-expansion` | high | `<=5.0.7` | Fresh DoS advisory covering all released versions; no fixed version yet. Deep transitive. |

Lower-severity auto-semver items (`qs`, `@discordjs/rest`, `discord.js`,
`@cypress/request`, `body-parser`) ride along with the bumps above.

## Exposure

- **Runtime-facing** (fix first when possible): `undici` (the HTTP client behind
  `fetch`) and `@modelcontextprotocol/sdk` (MCP transport). `undici` has a
  compatible fix now; the MCP SDK needs a tested major bump.
- **Install-time only**: the `tar` critical is exercised by `@discordjs/node-pre-gyp`
  extracting prebuilt binaries at install, not at request time. Real exposure is
  limited to installing from an untrusted registry/tarball. It stays flagged because
  no fixed `tar` exists, not because a request path reaches it.
- **Dev / CLI tooling**: `blessed-contrib` (TUI), the `@discordjs/voice` chain
  (only if voice is used), `@cypress/request` (tests). Lower request-path exposure.

## Remediation plan

1. Land `undici@^6.28.0` and `xml2js@^0.6.2` via root `overrides` in a dedicated
   PR that regenerates the lockfile on Node 24, with `npm ci` + `npm test` green.
2. Bump the bucket-B majors one PR each, each gated on hand-testing the feature the
   suite does not cover (MCP provisioning; the TUI; `uuid` call sites).
3. Track the bucket-C advisories (`tar`, `lodash`, `brace-expansion`, the
   `@discordjs` voice chain). Re-run `npm audit` when they publish fixes. If the
   voice stack is not needed, dropping `@discordjs/voice` removes the `tar` critical
   and its four dependent highs in one move.

## Method

`npm ci` then `npm audit` / `npm audit fix` in a throwaway worktree, never the live
host tree. Version and advisory-range facts come from `npm audit --json` and
`npm view`. Re-verify on Node 24 before acting; these were taken under Node 20.
