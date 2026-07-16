# Roadmap: Vault · Auth · Self Silo · Data Silos · Backups

> Status: **design agreed, build not started.** This is the canonical plan; progress is tracked in
> the GitHub epic (see bottom). It turns asmltr into an identity/core platform whose credentials,
> memory, and artifacts are portable and restorable — with the [TRUST Protocol](https://github.com/jarethmt/trust-protocol)
> as a hard dependency (its first real-world home).

## The one-line vision

An agent's identity persists through **memory + runtime**. The **Self silo** is the portable soul —
identity, relationships, full conversation history, internal state, and *every artifact the agent
creates* — sealed by an operator passphrase, restorable onto a fresh install, and reachable (trust-
gated) by peer agents. Credentials live in the **TRUST vault**, never in the repo, never in BWS.

## Six constructs, one substrate

```
  AUTH LAYER  ──unlocks──▶  TRUST VAULT (hard dep)  ──secrets──▶  asmltr core
  (local + OIDC)                │                                    │
       │                        │ credentials view (names, not values)│
       ▼                        ▼                                    ▼
  ┌──────────────────────  DATA SILOS  ────────────────────────────────┐
  │  Self silo (one) ── default home for artifacts + identity +        │
  │     relationships + FULL transcripts + internal state              │
  │  Project silos (many) ── tagged, provisionable, trust-gated API     │
  └───────────────┬────────────────────────────────────────────────────┘
                  ▼
            BACKUPS ── encrypted snapshots (passphrase) ──▶  STORAGE BACKENDS
                                                             (local · S3/R2 · Nextcloud/WebDAV · SFTP)
```

- **Storage backends** — the shared transport (`shared/storage.js`: `put/list/get/delete`). Used by
  *both* silos and backups. A silo is backend-agnostic and migratable.
- **Data silos** — schema + trust-verified API + backend ref + index. The Self silo (one, special) and
  project silos (many). An agent may expose its own silo for a peer to connect to → the bridge to
  federation (same construct, TRUST-tier gated, instantly revocable).
- **Backups** — encrypted point-in-time snapshots of silos + config + the re-sealed vault.
- **Credentials** — the TRUST vault (AES-256-GCM, use-but-never-see proxy, audit chain). asmltr
  *hard-depends* on it.
- **Auth layer** — built-in operator login (local + OIDC) so operators don't have to bring their own.

## Locked decisions

| Decision | Choice |
|---|---|
| Root key | **Passphrase** (Argon2id-derived) |
| Conversation history | **Keep all, forever** (append-only); compaction is a *derived* layer |
| Vault dependency | **Hard** — home for asmltr's keys *and* any credential the agent stores; GUI vault view |
| Auth 2FA | **TOTP + passkey (WebAuthn)** both |
| Vault-locked boot | **Degraded but loud** — asmltr boots read-only/observability with a prominent "vault locked" banner; secret-needing connectors wait until unlock |
| Self-silo storage | **Local on disk**; backups pushed off-box *if* a remote backend is configured |

## The security model (auth ↔ vault, without a brute-force oracle)

Three secrets, **separated**, so a web portal never becomes an attack surface on the encryption key:

1. **Web login credential** ≠ vault passphrase. Local account (Argon2id password + TOTP + WebAuthn
   passkey) *or* OIDC. Rate-limited + lockout. Issues only a session cookie.
2. **Vault passphrase** → Argon2id → vault master key. Vault is **locked at rest**; the raw passphrase
   is never a web-submittable auth secret.
3. **Linkage (login unlocks vault), safely:** store the vault key **envelope-wrapped under a key
   derived from the login** — `E(vault_key, K_login)`. A successful, throttled, 2FA-gated login
   unwraps it into server memory for the session. A brute-forcer hits the *rate-limited 2FA login*,
   never the crypto; winning the login only releases a blob useless without the login secret.
4. **Paranoid mode (opt-in):** unlinked — require the passphrase entered separately, never wrapped, so
   even a full GUI compromise can't unlock the vault without a human typing it.

The backup root key derives from the vault passphrase (KEK/DEK): the encrypted archive contains the
re-sealed vault + silos + config; restore = "provide the passphrase." These same auth/keying
primitives are the seed of **cast identity proof** later (Ed25519 challenge/response between peers).

## The Self silo — layout & session awareness

The Self silo is the **default birthplace of every artifact**. For that to hold, *every session must
know the silo exists and how it's laid out* — otherwise the agent scatters files across the system.

### On-disk layout (proposed)

```
~/.asmltr/silos/self/                 # configurable: ASMLTR_SELF_SILO
  silo.json                           # manifest: id, name, schema version, backend ref, trust policy
  index.jsonl                         # append-only map: {ts, session, kind, path, tags, external_ref?}
  artifacts/                          # one-off outputs — <date>-<session>/<name> (PDFs, images, exports)
  workspaces/                         # multi-file builds / apps in progress
  memory/
    identity/                         # identity.md, preferences, story, aesthetic, palette
    transcripts/                      # FULL SDK conversation history (append-only, keyed by engine_session_id)
    dreams/                           # compacted/abstracted memories (derived; raw never touched)
```

### Awareness mechanism (mirrors the identity anchor + toolbelt that already work)

The core already injects `identity.fullIdentity()` + an `ASMLTR TOOLBELT` block into **every** turn's
system prompt (`core/src/server.js`). We add a **SELF SILO** block the same way:

- **Teach the convention, not the data:** inject a compact description of the silo root, the standard
  subdirs, and the rule — *"When you create an artifact and the task doesn't specify a location, create
  it under the Self silo; register it in the index. Don't scatter files in random system paths."*
- **Set the default cwd:** terminal (`asmltr claude`) and channel sessions default their working dir
  to `workspaces/` (or a per-session workspace) inside the silo, so `pwd` is already the right home.
- **A CLI surface** (`asmltr silo ls|new|put|index|find`) so the agent inspects/writes the silo and
  its map on demand — the same "teach the commands, query live" pattern as the toolbelt (never dump
  the whole index into the prompt).
- **External pointers:** when the agent *does* commit to a git repo or edit a system/root file, it
  records a pointer (`external_ref`) in the index — so backup/restore still knows about the 99% and
  can report the 1% it can't carry.

> Open for discussion before building P3: exact schema of `index.jsonl`, whether workspaces are
> per-session or per-project, and how strongly to bias the default cwd vs. let the task override.

## Phased roadmap

- **P0 — Substrate & vault dependency.** `shared/storage.js` (local + Nextcloud/WebDAV); `shared/secrets.js`
  trust-protocol provider (use-but-never-see proxy + SACRED raw-fetch for protocol secrets; de-BWS);
  hard-dependency boot wiring + lock/health status.
- **P1 — Auth layer.** Local operator auth (Argon2id + TOTP + WebAuthn passkey), sessions, rate-limit/
  lockout, login screen; OIDC relying-party config. Coexists with (doesn't require) Authelia.
- **P2 — Vault unlock + credentials view.** Login↔vault envelope-wrapping; degraded-but-loud locked
  state; Settings → Vault (list keys + metadata + audit, add/rotate/delete, per-key tier — never values).
- **P3 — Self silo + artifact-home.** Silo construct; Self silo as default cwd/output; the index/map;
  the SELF SILO awareness injection; migrate identity + relationships + transcripts + state under it.
- **P4 — Backups.** `scripts/backup.js` (consistent SQLite `.backup()`, append-only transcript sync,
  re-seal vault, encrypted archive + manifest); restore via setup.d + rehydrate + verify-restore;
  auto-snapshot before every self-update; CLI + Settings → Backup.
- **P5 — Project silos + federation edge.** Provision tagged silos; trust-gated silo API for peer
  connect (to project silos or the Self silo), instantly revocable via TRUST kill switches.
- **P6 — Dreaming / sleep.** Scheduled compaction: raw history → abstracted memory artifacts
  (summaries + embeddings → eve-search) stored back in the silo. Raw is never touched; regenerable.

## Relationship to existing tickets

- **#25 (Backup system)** → P4 (+ the storage-backend substrate in P0).
- **#26 (Data silos)** → P3 + P5 (+ storage backends in P0).
- Builds on shipped work: the identity anchor (P3 awareness), `shared/secrets.js` provider pattern
  (P0), `setup.d` + applied-ledger (P4 restore), the cast/trust store + TRUST tiers (P2/P5).
