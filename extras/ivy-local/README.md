# extras/ivy-local — osiris-only MCP wrappers

Eve: skip this tree. Ivy on this box only.

Small stdio MCP servers Grok/Ivy calls via `~/.asmltr/mcp.json` and `grok mcp add`.
They do **not** fork `grok.js`. Secrets stay out of git.

| Server | Talks to | Tools |
| --- | --- | --- |
| `corona` | `http://127.0.0.1:12701` | `corona_health`, `corona_recipe`, `corona_cigars`, `corona_cooking` (no `/say`) |
| `rolodex` | Ivy cache `~/.asmltr/rolodex-cache` (source `:12702/export`) | `rolodex_health`, `rolodex_search`, `rolodex_get`, `rolodex_alias`, `rolodex_sync` |
| `onenote` | Graph, creds in `~/.asmltr/onenote/{token.json,.client.json}` mode 600 | `onenote_health`, `onenote_login`, notebooks/sections/pages/get/create/update |

Rolodex is **Ivy’s two-file setup** (her choice, 19 Aug 2026): `contacts.json` is the daily Google dump; `aliases.json` is the static nickname index. People cards stay relationship memory. Do not invent a third store. Cache path is `~/.asmltr/rolodex-cache`, not Adjutant’s 08:00 box cache and not `/home/adjutant/rolodex`. Timer: **07:30 America/New_York**, `OnBootSec=3min`, `Persistent=true`. Sync never writes `aliases.json`. Prefer an alias hit. A phone number is not permission to text. Voice/SMS parked.

Cigar writeups: kektech `#cigars` first (who, when ET 24-hour), then exactly `Additional notes from the web`.

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
# asmltr ask 'Use corona_health and rolodex_health, then say ok.'
stat -c '%a %n' ~/.asmltr/onenote/token.json ~/.asmltr/onenote/.client.json
# expect 600 — do not cat
systemctl --user list-timers ivy-rolodex-sync.timer
```

Do not commit `token.json`, `.client.json`, cache JSON, or `.venv`.
