# Notify & read-aloud

Two ways asmltr uses **voice** to keep you in the loop when you're away from a chat window:

- **Notify** — the assistant (or a [schedule](SCHEDULES.md)) proactively **reaches you** with a spoken /
  pushed message, trying the best channel that can actually get through.
- **Notification reader** — your phone reads **incoming notifications** aloud over your headphones as a
  short spoken synopsis, skipping the noise.

Both are voice-first, both respect quiet hours, and both are configurable.

---

## Reaching you — `asmltr notify`

When something needs your attention out-of-band — a scheduled morning brief, "your build finished," an
alert while you're away — the assistant calls:

```bash
asmltr notify "<message>" [--title "<title>"] [--force] [--silent]
```

| Flag | Effect |
|---|---|
| `--title` | A short heading shown with the message. |
| `--force` | Deliver even during quiet hours (use only when it's genuinely urgent). |
| `--silent` | Skip the spoken step — deliver as text only. |

A schedule whose prompt says *"notify me…"* or *"send me a message"* is exactly this command. It's also
the primitive the morning brief uses.

### The delivery ladder

`asmltr notify` doesn't just fire and hope — it walks a **ladder** and stops at the first step that can
actually reach you:

1. **Read aloud** — if a connected assistant device (the phone app or a headless control link) is present
   and allowed to speak, it's spoken aloud through your configured voice.
2. **Push** — a push notification to the device (when a push sender is configured).
3. **Text fallback** — a message to a configured channel (Telegram / Discord / email).

If a step isn't reachable or isn't configured, the ladder falls through to the next. The command reports
which step delivered it (`✓ notified via android`) or that nothing landed — so a notification never
silently vanishes into the void.

**Quiet hours** suppress the *spoken* step (so a 3 AM brief won't wake you); the message still travels the
rest of the ladder as text unless you passed `--force`. If no quieter step is configured, it's held rather
than spoken.

### Configuring delivery

Set the policy in the dashboard under **Settings → Notifications → Notify delivery**:

- **Quiet hours** — the window where the spoken step is suppressed.
- **Only read aloud over headphones** — never speak over the phone's loudspeaker.
- **Text fallback** — the channel + target that catches messages the spoken step can't (recommended, so
  quiet-hours notifications still reach you silently).

Under the hood this is stored at `~/.asmltr/notify.json` and served by `POST /v2/notify` +
`/v2/notify/config`; connectors are reached through the connector manager's unified send path, so there
are no host-specific scripts to wire up.

---

## Reading phone notifications aloud

The **notification reader** speaks a natural-language synopsis of incoming phone notifications over your
headphones — like a conversational, selective version of a car's "read my messages." It's a native feature
of the Android app.

### How it works

- The app watches posted notifications (you grant Android's **Notification access** once).
- Each one is judged **on-device by the local engine** — it returns whether to speak it, a priority
  score, and a one-sentence synopsis. Because this runs on the local Agent SDK (not a metered/cloud API),
  the content of your private notifications never leaves the device for a third-party key.
- If it clears your threshold, the app reads the synopsis aloud
  (*"You've got a direct message on Discord — they're done with the project"*).
- A burst of notifications is summarized together rather than read one by one.

### Gating & settings (app → **⚙ Notifications**)

- **Enable readout** on/off, and **only over headphones** (skip when on the speaker).
- **Quiet hours** — no readout during your configured window.
- **Priority threshold** — read only notifications scored at or above your bar.
- **Per-app allow/deny** and a **sender allow-list**; ongoing/transport/foreground-service noise is
  filtered out automatically.
- **Verbosity** — headline vs. full synopsis — and **burst-summarize** on/off.

### Privacy

Notification text is sensitive by nature. The synopsis is generated **locally**, nothing is retained
beyond what's needed to de-duplicate a burst, and readout only happens over a private audio route
(headphones). Android's own consent screen gates the whole feature.
