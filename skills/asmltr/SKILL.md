---
name: asmltr
description: How to drive asmltr — the assistant's own multi-channel backend on this machine. Use whenever you need to send/route a message to any channel (Discord, Telegram, email, …), attach or find a file, read or browse email, approve held replies, post cross-session awareness, or monitor/take over other sessions. One CLI (`asmltr`) is the front door to all of it.
---

# asmltr — your backend across every channel

asmltr is the assistant's own backend running on this machine: every chat surface (Discord,
Telegram, email, MCP, GitHub, an OpenAI-compatible API) is a **connector** feeding one core that
runs the local Agent SDK, plus a collector + dashboard for monitoring. You drive all of it with the
**`asmltr` CLI** (run `asmltr help` for the authoritative, always-current list; `asmltr <cmd>` prints
per-command usage).

This skill is your high-level map. Reach for it when a task means "get this OUT to a channel",
"find/attach a file", "read my email", "approve a reply", "make the other sessions aware", or
"watch / take over a session".

## The one rule that trips people up

- **Replying to a conversation you're already in** (a Discord/Telegram/email message you're
  answering) → just **output your reply text**. The connector delivers it. Do NOT use `asmltr send`.
- **`asmltr send` is for INITIATING or REDIRECTING** — messaging a channel you're not currently in,
  or routing your answer somewhere else.

## Messaging out (any channel)

```bash
asmltr send <channel> <target> "<text>"                 # discord/telegram/email/…
asmltr send <channel> <target> --file <abs-path> [--caption "..."]   # attach a file
asmltr send email <addr> "<body>" --subject "<subj>" [--file <path>] # email w/ subject + attachment
```
- **target** is channel-specific: a Discord channel id/alias, a Telegram chat (omit for default),
  an email address. `asmltr send/targets` (via the manager) lists live outbound connectors and,
  per connector, whether it supports **attachments** and is **readable**.
- Only connectors that declare attachment support accept `--file` — others return a clean error.
- To attach something a user sent you elsewhere, find it first with `asmltr uploads` and pass its
  stored path to `--file`.

## Email (send · browse · read)

Email is a full channel — send *and* read:
```bash
asmltr send email <addr> "<body>" --subject "<subj>" [--file <path>]
asmltr mail                        # inbox, newest first (● = unread)
asmltr mail list -n 30 --unseen    # more / only unread
asmltr mail read <uid> [--seen]    # full body; saves attachments to the upload area + prints paths
asmltr mail search "<query>"       # from / subject / body
```
Inbound mail is handled automatically per the email connector's `approval_policy` (full-trust →
auto-reply; others → a **draft** for approval). Any install-specific rules — the identity/signature
to send as, which senders are trusted — live in this machine's own agent docs (e.g. `CLAUDE.md`),
not in this generic skill.

## Files across channels

```bash
asmltr uploads [search]            # every file a user sent on ANY channel (--channel --since 2h|1d --sender)
asmltr uploads get <id>            # print one upload's stored path (to Read it / --file it back out)
```
When a user says "the file/recording/doc I sent you" — even from another app — check here first.

## Held replies (approval queue)

```bash
asmltr drafts                      # replies any connector held for your approval
asmltr drafts show <id> · send <id> · discard <id>
```
Also visible on the dashboard **Drafts** tab.

## Cross-session awareness (you are one of several sessions)

```bash
asmltr ls                          # active sessions
asmltr map                         # sessions grouped by working dir (collision radar)
asmltr who <path>                  # which sessions recently touched a file/dir
asmltr announce "<text>" [--to <target>] [--urgent] [--ttl <sec>]   # awareness note into other sessions
asmltr announcements               # live announcements
```
Check `map`/`who` before duplicating work another session is already doing.

## Monitoring & takeover

```bash
asmltr                             # live TUI dashboard
asmltr tail | watch <key> | events | system | brief
asmltr attach <key>                # claim a channel session + resume in tmux (attach/detach)
asmltr release <key>               # end takeover; channel resumes
asmltr kill <id> | stop <id> | diff <id>
```

## Don't

- Don't hit connector HTTP endpoints or SMTP/IMAP directly — go through `asmltr` so everything stays
  one observable control plane.
- Don't hardcode ports/paths — `asmltr` already knows where the core/collector/manager are.
- Don't re-derive the command list from memory — `asmltr help` is authoritative and current.
