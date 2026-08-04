# Notify / Read-Aloud + Notification Reader

!!! success "Shipped"
    **Part A** (proactive read-aloud / delivery ladder) — `shared/notify.js`, `POST /v2/notify` +
    `/v2/notify/config`, `asmltr notify` CLI, a `speak` frame on the android connector, and the app +
    headless control-link reading it aloud. **Part B** (notification reader) — native
    `AsmltrNotificationService` → `/gw/notify-triage` (default engine, on-device) → native TTS over BT,
    with a 3s burst, per-app/headphones/threshold gating, and app settings. Config: dashboard
    **Schedules → Notify delivery** (ladder) + the app's **⚙ Notifications** (reader).

Two related capabilities, one spine: **asmltr proactively reaching the user with spoken/pushed messages**,
and **the phone reading incoming notifications aloud**. Replaces the retired `eve-wake-up-alarms` cron hack.

## Why the old way was wrong
The morning alarms shelled raw `claude -p "..."` from cron. Problems:
1. **Session leak** — `claude -p` registers a session via the claude-code hook but never emits a
   session-end, so every run stacked a dead "active" session in the dashboard (24 found + purged).
2. **Fire-and-pray delivery** — it spoke via a host TTS script regardless of whether anyone could hear it
   ("I never hear my wake-up message"). No notion of *reachability* or confirmation.
3. **Not configurable, not channel-aware** — hardcoded times, one delivery path.

Rule going forward: **never generate via raw `claude -p` in automation.** Use the core fast path
(`/v2/handle` lean/no-tools, or a static template) so sessions are managed and nothing leaks.

---

## Part A — asmltr notify/read-aloud primitive (proactive → user)

A first-class **outbound notify** that any session/schedule can call, which picks the best way to actually
reach the user and (ideally) confirms it landed.

**Delivery ladder (best reachable wins, configurable):**
1. **Android assistant read-aloud** — if the phone's control link is up AND BT headphones connected AND
   the app is allowed to speak → push a `speak` frame; the app TTS-reads it (uses the existing
   `/gw` + speech layer). This is the "spoken to me" path the wake-up wanted.
2. **Push notification** — Web Push (PWA, already scaffolded #52) / a native notification on the phone.
3. **Telegram / Discord / email** — text fallback via existing connectors.

**Scheduling:** a small scheduler (core cron table or a `scheduler` connector) fires notify jobs
(morning brief, reminders, "pester" tasks) → each job = { when, audience, message|prompt, delivery_policy }.
Message is either a static template or generated via the lean core path (no session leak).

**Reachability + confirmation:** the notify primitive checks device presence (control link connected? BT
connected? quiet hours?) before speaking; falls down the ladder if not reachable; records delivered/heard
so we don't repeat or fire into the void.

**Reuse, don't reinvent:** `/out` push + `/gw` speech (android connector), `shared/speech`, the draft/approval
primitive, and the connector manager's unified `/send` as the text-fallback executor (telegram/discord/email).

---

## Part B — Android notification reader (phone notifications → spoken synopsis)

Read incoming phone notifications aloud over BT headphones, as a smart natural-language synopsis, with
AI prioritization so low-value ones are skipped. Like Google Assistant's notification readout, but
conversational and selective.

**Mechanism:**
- Native **`NotificationListenerService`** (user grants "Notification access" once) captures each posted
  notification: `{ package, appLabel, title, text, when, category, ongoing }`.
- Gate: only when **enabled** AND **BT audio route connected** (skip when on speaker) AND not in quiet hours.
- Pipeline per notification (debounced/deduped, rate-limited):
  1. App → asmltr core a lean call: given the notification, return `{ speak: bool, priority: 0-100,
     synopsis: "natural sentence" }`. Runs on the **local Agent SDK (on-Max, not metered API)** — keeps
     private notification content off a metered/cloud key, consistent with asmltr's no-API-key rule.
  2. If `speak && priority >= threshold` → app TTS-reads the synopsis
     ("scoutg just messaged you on Discord — he's done with the project").
- **Prioritization:** the model scores importance (a DM to you > a group ping > a marketing push). Plus
  hard rules: per-app allow/deny, category filters (skip `ongoing`/transport/foreground-service noise),
  sender allow-list. Burst handling: if N arrive at once, summarize together ("3 new Discord messages, the
  important one from scoutg: …") instead of reading each.

**Configurable in Settings (global voice/notify config, GUI + TUI + app):**
- enable notification readout · only-with-headphones · quiet hours
- priority threshold (read only ≥ X) · per-app allow/deny · sender allow-list
- verbosity (headline vs. full synopsis) · burst-summarize on/off

**Privacy note:** notification text is sensitive. Synopsis runs locally (Agent SDK); nothing is stored
beyond what's needed to dedupe; readout only over a private audio route (headphones). Surface this clearly
in the enable flow (Android already forces the Notification-access consent screen).

---

## Rollout phases
1. **A1** ✅ — `speak` delivery frame + the app (and headless control link) read pushed messages aloud;
   presence + quiet-hours gating, headphones hint.
2. **A2** ✅ — scheduler ([Schedules](SCHEDULES.md)) + notify jobs (morning brief is now a prompt job that
   calls `asmltr notify`, no `claude -p`); delivery ladder (android → push → text).
3. **B1** ✅ — `NotificationListenerService` + settings (enable, headphones-only, per-app deny, BT-device
   pick) with noise filters (ongoing/transport/service skipped).
4. **B2** ✅ — AI synopsis + prioritization via the default engine (on-device Agent SDK) + 3s burst-summarize.
5. **B3** — tuning: sender allow-lists, verbosity presets, push (web-push) step. *(future)*
