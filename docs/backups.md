# Backups

A backup is a **portable, encrypted, restorable snapshot** of an asmltr install (roadmap P4). One is
taken automatically before every self-update; you can also take them on demand
from the CLI or the dashboard.

## What's captured

| Component | Source | How |
|-----------|--------|-----|
| **SQLite DBs** | core sessions, trust store, insights | the SQLite **online-backup API** — a *consistent* snapshot, safe against the live running services (never a torn file copy) |
| **Home store** | `~/.asmltr` | identity + facets, `integrations.json`, the **silos** (Self + data), `context.d` |
| **Repo config** | gitignored, secret-bearing | `.env`, connector configs, trust `seed.json`, the Eve compose file, `CLAUDE.local.md` |

A `manifest.json` (version, label, timestamp, component list, per-artifact SHA-256) rides inside the archive.

## Encryption — vault-independent by design

The archive is a gzipped tar encrypted with **AES-256-GCM under a key derived from a passphrase**
(`scrypt`). This is deliberately **independent of the [TRUST vault](security/trust-vault.md)**: if you
encrypted backups with a vault key, you couldn't restore after *losing the vault* — the exact disaster
backups exist for. So a vault loss is itself recoverable from a backup.

File layout (tag at the end, so both encrypt and decrypt stream without loading the whole archive):

```
[ MAGIC(9) | salt(16) | iv(12) | ciphertext… | authTag(16) ]
```

### The passphrase

Resolution order: `--passphrase` → `ASMLTR_BACKUP_PASSPHRASE` → `TRUST_PROTOCOL_VAULT_PASSWORD`. On a
single box the vault password is a convenient default; **off-box backups should use a dedicated
passphrase**. There's no recovery if the passphrase is lost — GCM authentication rejects a wrong one.

## CLI

```bash
asmltr backup create [--label nightly] [--passphrase …]   # write a snapshot to ~/.asmltr/backups
asmltr backup list                                        # newest first
asmltr backup verify <file>                               # decrypt + check manifest + tar integrity
asmltr backup restore <file> [--dry-run]                  # --dry-run prints the plan and changes nothing
```

Restore decrypts, validates, then places each artifact back — **stashing any file it overwrites** under
`~/.asmltr/backups/pre-restore-<ts>/` first. After a restore, bounce the services:

```bash
pm2 restart asmltr-core asmltr-connector-manager asmltr-insights-collector
```

## Remote destinations

A backup can be pushed **off-box** to any configured [storage integration](integrations/index.md)
(WebDAV, S3-compatible, or a local path) — the encrypted archive is uploaded under an
`asmltr-backups/` prefix in the integration's root. Pass a destination by integration id:

```bash
asmltr backup create --label offsite --destination int_ab12cd34   # or pick it in the dashboard
```

The archive is already encrypted, so it's safe on third-party storage. `verify`/`restore` still operate
on a **local** file — pull the archive down first if it only lives remotely. Retention (below) prunes the
remote destination too.

## Scheduled backups & retention

**Settings → Backups → Scheduled backups** runs automatic snapshots on a timer, with retention:

| Setting | Meaning |
|---------|---------|
| **Every (hours)** | how often a snapshot is taken |
| **Destination** | local, or a storage integration (off-box) |
| **Max stored** | keep only the newest N (`0` = unlimited) |
| **Max age (days)** | drop anything older than this (`0` = no age limit) |

The scheduler runs **in-process in the core** (checked every ~10 min; persisted in
`~/.asmltr/backup-schedule.json`). It needs a passphrase available to the core process
(`ASMLTR_BACKUP_PASSPHRASE`, or the vault password) — without one, a due backup is logged and skipped
rather than failing. Retention runs after each scheduled snapshot, on both local and the remote destination.

## Dashboard

**Settings → Backups** lists existing snapshots, creates new ones (with a destination + optional one-off
passphrase), and configures the schedule. **Restore is intentionally CLI-only** — it's a destructive,
footgun-prone operation that shouldn't be one mis-click away in a browser.

## Auto-snapshot before self-update

`scripts/update.js` takes a `pre-update` snapshot before it checks out new code — a *data-level* safety
net on top of the git rollback point. It's best-effort: skipped when no passphrase is configured or when
`ASMLTR_BACKUP_ON_UPDATE=off`, and a snapshot failure never blocks the update (the git rollback still
applies). Config: `ASMLTR_BACKUP_DIR` (default `~/.asmltr/backups`), `ASMLTR_BACKUP_PASSPHRASE`.

## See also

- [Data silos & the Self silo](silos.md) — the memory + artifacts a backup captures.
- [TRUST vault](security/trust-vault.md) — the credential store a backup lets you recover *around*.
