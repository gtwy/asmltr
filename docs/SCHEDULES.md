# Schedules — GUI cron for asmltr (prompt jobs + shell jobs)

!!! success "Shipped"
    Store `shared/schedules.js` · tick + endpoints in `core/src/scheduler.js` + `core/src/server.js`
    (`/v2/schedules`) · dashboard **Schedules** view. Prompt jobs run as managed turns (no session
    leak); shell jobs run host commands. The morning brief is now a prompt job that calls `asmltr notify`.

A dashboard-managed scheduler: create jobs that fire **on a schedule**, each either an **LLM prompt**
(runs a fresh asmltr turn on a reasoning engine) or a **shell command / script**. This is "cron with a
GUI," and it's what powers the morning brief again + becomes the scheduler for **asmltr notify**.

## Why (supersedes the wake-up cron + the dead "daemons" panel)
- The retired wake-up alarms were raw `claude -p` in crontab → leaked sessions, hardcoded, invisible.
- The dashboard "Persistent daemons" panel never populated (no reconcile source ever registers
  `kind:persistent` rows) and belongs in System Info, not Live — remove it.
- Schedules replaces both: user-defined, visible, engine-managed (no session leak), and general-purpose.

## Job model
`{ id, name, enabled, schedule, type, ...payload, last_run, next_run, last_status, last_output }`
- **schedule**: friendly (time-of-day + weekdays) with an **advanced raw-cron** field; stored normalized.
- **type: "prompt"** → `{ engine?: default|claude|codex|gemini, prompt, session?: "new"|"<conversation_key>" }`.
  Runs through the core pipeline as a real turn (NOT `claude -p`) → no session leak. The prompt can tell
  the assistant to *do* something, e.g. use `asmltr notify` to deliver a morning brief.
- **type: "shell"** → `{ command | script_path, cwd?, timeout_s? }`. Runs on the host as the asmltr user
  (same power as the crontab it replaces). Output captured → `last_output` for the GUI.

## Scheduler engine
A tick in the core (setInterval ~30s; no new dep) evaluates due jobs against `next_run`; on fire it
dispatches a prompt turn or spawns the shell command, records status/output, computes the next run.
Missed-while-down jobs: run once on next tick if overdue (configurable). Concurrency-guarded per job.

## Storage + API + GUI
- Store: `~/.asmltr/schedules.json` (gitignored) via a `shared/schedules.js` module.
- Core: `GET/POST/PATCH/DELETE /v2/schedules`, `POST /v2/schedules/:id/run` (run-now).
- GUI: a **Schedules** view — list (name, next/last run, last status, enable toggle, run-now, edit,
  delete) + an add/edit form (name, schedule picker, type, prompt+engine OR command/script). Manifest-driven
  where possible so the TUI gets it too.

## Security
Shell jobs execute host commands — gate behind the dashboard's owner-only 2FA (same trust as crontab).
Prompt jobs run the engine (already trusted). Surface the shell-exec power clearly in the add form.

## Morning brief, rebuilt
A **prompt** job at 08:00 weekdays: *"Write a warm ~25-word wake-up for Jareth and deliver it with
`asmltr notify` (read-aloud)."* → engine runs → asmltr notify → phone reads it over BT. Until notify
Part A ships, the prompt can call the existing `notify-jareth` / android `/out` push instead.

## Decisions (as shipped)
1. **Schedule UX** — friendly time+weekday picker with an advanced raw-cron field. Both compile to a
   standard 5-field cron string that everything downstream evaluates uniformly (`shared/schedules.js`).
2. **Scheduler home** — a core `setInterval(~30s)` tick (`core/src/scheduler.js`, started from
   `server.js`); no new process, no new dep. Per-job concurrency guard; overdue jobs fire once on the
   next tick after downtime.
3. **Shell jobs** — arbitrary command/script allowed (cron parity), gated behind the owner-only
   dashboard. Prompt jobs run at operator trust via an internal, moderation-bypassed **Scheduler**
   principal, seeded idempotently on start.
