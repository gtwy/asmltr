# extras/ivy-local — osiris-only MCP wrappers

Eve: skip this tree. Ivy on this box only.

Small stdio MCP servers Grok/Ivy calls via `~/.asmltr/mcp.json` and `grok mcp add`.
They do **not** fork `grok.js`. Secrets stay out of git.

| Server | Talks to | Tools |
| --- | --- | --- |
| `corona` | `http://127.0.0.1:12701` | `corona_health`, `corona_recipe`, `corona_cigars`, `corona_cooking` |
| `rolodex` | Ivy cache `~/.asmltr/rolodex-cache` (source `:12702/export`) | `rolodex_health`, `rolodex_search`, `rolodex_get`, `rolodex_alias`, `rolodex_sync` |
| `onenote` | Graph, creds in `~/.asmltr/onenote/{token.json,.client.json}` mode 600 | `onenote_health`, `onenote_login`, notebooks/sections/pages/get/create/update |

Rolodex cache is **Ivy’s**, not `/home/adjutant/rolodex` and not the Adjutant box cache. A user systemd timer refreshes `contacts.json` at **07:30 America/New_York**. `aliases.json` is never overwritten by sync.

## Install on osiris

```bash
cd /home/adjutant/src/asmltr
git checkout ivy
git pull
bash extras/ivy-local/register.sh
```

`register.sh` creates `extras/ivy-local/.venv`, merges `~/.asmltr/mcp.json`, runs `grok mcp add`, enables `ivy-rolodex-sync.timer`, and does one cache sync.

## Test

```bash
curl -sf http://127.0.0.1:12701/health
curl -sf http://127.0.0.1:12702/health
grok mcp list
# one cached lookup after sync
# asmltr ask 'Use corona_health and rolodex_health.'
stat -c '%a %n' ~/.asmltr/onenote/token.json ~/.asmltr/onenote/.client.json
# expect 600 — do not cat
systemctl --user list-timers ivy-rolodex-sync.timer
```

Do not commit `token.json`, `.client.json`, cache JSON, or `.venv`.
