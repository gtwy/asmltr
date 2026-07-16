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

## Dashboard

**Settings → Backups** lists existing snapshots and creates new ones (optionally with a one-off
passphrase). **Restore is intentionally CLI-only** — it's a destructive, footgun-prone operation that
shouldn't be one mis-click away in a browser.

## Auto-snapshot before self-update

`scripts/update.js` takes a `pre-update` snapshot before it checks out new code — a *data-level* safety
net on top of the git rollback point. It's best-effort: skipped when no passphrase is configured or when
`ASMLTR_BACKUP_ON_UPDATE=off`, and a snapshot failure never blocks the update (the git rollback still
applies). Config: `ASMLTR_BACKUP_DIR` (default `~/.asmltr/backups`), `ASMLTR_BACKUP_PASSPHRASE`.

## See also

- [Data silos & the Self silo](silos.md) — the memory + artifacts a backup captures.
- [TRUST vault](security/trust-vault.md) — the credential store a backup lets you recover *around*.
