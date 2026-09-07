# Email connector

The email connector (`connectors/types/email/index.js`) turns the assistant's mailbox into a
channel: IMAP IDLE for inbound, SMTP for replies, same core trust and moderation as every other
surface.

## Inbound Authentication-Results

Inbound mail is accepted only when **Authentication-Results** on the message says DKIM, SPF, and
DMARC each `pass`, **and** the header's authserv-id is on a host allowlist.

The CHECK is in this public connector (every install). The VALUE is personal:

- File: `~/.asmltr/email-authserv.json` (mode `600`), shape `{ "authserv_ids": ["…"] }`
- Override path with `ASMLTR_EMAIL_AUTHSERV_FILE` if you need a temp/test file
- Empty or missing file: fail closed (no turn, no reply). Logged reason: `authserv unset`

Honor **only** `Authentication-Results`. Never use `ARC-Authentication-Results` as a substitute.
If several AR headers are present, only the one whose authserv-id is allowlisted counts. Fail
closed for missing AR, wrong authserv, or ARC-only.

### How to set the value (LLM-assisted installs)

Look at a **real message in the bot mailbox** (mail delivered TO the assistant address). Copy the
**first token** of `Authentication-Results` — the authserv-id before the first `;`.

That token is the stamp from the server that **hosts the bot address**, not the sender.

Examples (examples only, not repo defaults):

- Google-hosted mailbox: `mx.google.com`
- Microsoft 365-hosted mailbox: `mx.microsoft.com`

Do **not** copy the DNS MX hostname. Google MX is `aspmx.l.google.com`; the AR token is
`mx.google.com`. Microsoft MX may look like `protection.outlook.com`; the AR token is typically
`mx.microsoft.com`.

```json
{ "authserv_ids": ["mx.google.com"] }
```

## IMAP IDLE watchdog

Inbound mail is still **IDLE-first**. The watcher does not fall back to minute polling.

A half-open IMAP socket (IDLE died, no `close` event) used to look healthy: the process stayed up,
the manager log ring rotated (`LOG_RING=200`), and new mail waited until a later reconnect
caught up. The watchdog now:

1. **Refresh IDLE** with ImapFlow `maxIdleTime` (default 10 minutes) so the session is ended
   with DONE and restarted before a long-lived IDLE goes stale.
2. **Probe** about every `ASMLTR_EMAIL_IMAP_PROBE_MS` (default 60s): send DONE / break IDLE,
   then a time-boxed NOOP (default 35s). Skip the probe while `busy` (a `fetchNew` is in
   progress) so the mailbox lock is not interrupted.
3. **Backoff reconnect** after 3 consecutive probe/connect/close failures (10s → 20s → 40s …
   capped at 5 minutes). A successful probe resets the streak. The UID cursor (`lastUid`) is
   not reset on reconnect.
4. **Journal** probe/fail/reconnect lines to `~/.asmltr/email-imap-<instance>.jsonl` (mode
   `600`; override with `ASMLTR_EMAIL_IMAP_JOURNAL`). Reasons are address-stripped. The
   in-memory manager ring is no longer the only record.
5. **Rate:** `imap_probe_fails_hour` on `GET /health` and `health()`, and `fails_hour=` on
   the journalled probe-fail line.

| Env | Default | Role |
| --- | --- | --- |
| `ASMLTR_EMAIL_IMAP_PROBE_MS` | `60000` | Probe interval |
| `ASMLTR_EMAIL_IMAP_PROBE_TIMEOUT_MS` | `35000` | DONE+NOOP deadline |
| `ASMLTR_EMAIL_IMAP_MAX_IDLE_MS` | `600000` | ImapFlow IDLE refresh |
| `ASMLTR_EMAIL_IMAP_RECONNECT_BASE_MS` | `10000` | First reconnect delay |
| `ASMLTR_EMAIL_IMAP_RECONNECT_MAX_MS` | `300000` | Backoff cap |
| `ASMLTR_EMAIL_IMAP_BACKOFF_AFTER` | `3` | Failures before delay doubles |
| `ASMLTR_EMAIL_IMAP_JOURNAL` | `~/.asmltr/email-imap-<id>.jsonl` | Persistent flap log |
