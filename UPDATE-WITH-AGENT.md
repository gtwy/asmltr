# Updating asmltr — instructions for an AI coding agent

**You are an AI coding agent on a machine where asmltr is already installed and running.** Follow these
steps to pull the latest version and restart cleanly. If a step fails, stop and report the exact error.

Your configuration lives in **gitignored** files that a code update does NOT touch:
`.env`, `connectors/types/mcp/clients.json`, `core/src/trust/seed.json`,
`connectors/types/discord/channel-aliases.json`. They are untracked, so the git commands below leave
them intact. Do not delete or overwrite them.

---

## 0. Locate the install + record a rollback point

`cd` into the asmltr repo (where it was cloned). Record the current commit so you can roll back:

```bash
cd /path/to/asmltr            # the existing asmltr checkout
git rev-parse --short HEAD    # ← RECORD this; it's your rollback point
git status --porcelain        # should be empty. If you have local edits to TRACKED files, `git stash` them first.
```

---

## 1. Fetch + update the code (keeps your gitignored config)

```bash
git fetch origin
git reset --hard origin/main   # move tracked files to the latest release
```

`git reset --hard origin/main` updates tracked files only — it does **not** delete untracked files like
your `.env` or `clients.json`. (It's used instead of `git pull` because the public repo is published as a
clean single-commit history, which a plain `git pull` can refuse to merge. `reset --hard origin/main`
always works.)

---

## 2. Refresh dependencies (package.json may have changed)

```bash
for d in core connectors insights/collector cli; do
  echo "npm install $d…"; (cd "$d" && npm install) || { echo "FAILED: $d"; exit 1; }
done
```

---

## 3. Reconcile config with any new options

- **New env keys:** compare `.env.example` to your `.env` and add any new keys you actually need.
  `git diff <recorded-commit> HEAD -- .env.example` shows exactly what changed this update.
- **New/changed example files** (e.g. a connector gained a `*.example.json` or a new config field): check
  whether your gitignored copy needs a matching addition. Instance configs and the trust store migrate
  automatically — new fields default safely, so you do **not** re-seed trust unless a changelog note says to.

---

## 4. Restart the services — **detached** (do NOT restart inline)

> ⚠️ **Critical if you were asked to update yourself over a channel (Discord/Telegram/etc.).**
> Your work is running *as a turn inside this very asmltr install*. Restarting `asmltr-core`
> **kills the process executing this turn** — so an inline `pm2 restart` cuts the update off
> partway (npm install/connector-cycle/verify never finish). This is the #1 reason an update
> "runs" but the new behavior never appears.

First, **queue a completion announcement** so the assistant confirms success *in the channel* once
it's back up (the manager holds it and delivers it after the restart, so it survives your turn dying):

```bash
# target = the channel/chat you were invoked from. For Discord it's the channel id, shown in your
# DISCORD CONTEXT as "Channel: #name (id …)". For other channels use the appropriate target.
curl -s -X POST 127.0.0.1:3024/announce -H 'Content-Type: application/json' \
  -d '{"channel":"discord","target":"<CHANNEL_ID>","text":"✅ Update complete — back online on the latest."}'
```

Then launch a **detached, delayed** restart that survives your turn ending and runs *after* you've
replied. It also clears any stale connector child (which would otherwise keep old code):

```bash
setsid bash -c 'sleep 8; pkill -f "connectors/runtime/run-instance.js" 2>/dev/null; sleep 2; pm2 restart asmltr-core asmltr-insights-collector asmltr-connector-manager' >/tmp/asmltr-update.log 2>&1 </dev/null &
```

Then **finish your reply** (e.g. "Pulled + installed the update — restarting now; I'll confirm here
when it's back"). The detached script does the actual restart independently, so your turn completes
cleanly and every connector comes back on the new code; the queued announcement then posts the ✅
confirmation to the channel.

> Tip: on Discord you can skip all of this — just have the owner run **`@<assistant> update-asmltr`**,
> which does the whole pull → install → detached-restart → confirm flow as a built-in command.

**Running the update from a plain shell** (a human, not through the assistant)? Then just restart directly:

```bash
pkill -f 'connectors/runtime/run-instance.js' 2>/dev/null; sleep 2
pm2 restart asmltr-core asmltr-insights-collector asmltr-connector-manager
```

---

## 5. Verify

```bash
curl -s 127.0.0.1:3023/health                                   # → {"status":"ok",...}
curl -s 127.0.0.1:3024/instances | head -c 400; echo            # instances still present
asmltr ls                                                       # CLI/TUI still works
```

Then have the user send a real test message on one channel and confirm a reply.

---

## 6. If something broke — roll back

```bash
git reset --hard <recorded-commit>          # from step 0
for d in core connectors insights/collector cli; do (cd "$d" && npm install); done
pm2 restart asmltr-core asmltr-connector-manager asmltr-insights-collector
```

Then report to the user what failed (with the error) and that you rolled back to the previous version.
