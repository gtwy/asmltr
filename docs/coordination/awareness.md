# Session awareness (ls / map / who)

Because one machine runs many sessions at once — Discord, Telegram, MCP, GitHub, plus interactive
`asmltr claude` sessions — a session can end up redoing work another is already doing, or two can
edit the same file at once. The awareness commands let a session (or an operator) **look around
before acting**: list what's running, see which repos are being worked in, and find who recently
touched a given path.

These are read-only views over the insights collector's event stream. Every session is told they
exist via the [ASMLTR TOOLBELT](#the-toolbelt-in-every-system-prompt) block in its system prompt,
with the explicit instruction to *check these before duplicating work another session is already
doing*.

## `asmltr ls` — active sessions

Lists every currently-active session with its surface, kind, age, idle time, token total, and
multiplexer:

```bash
asmltr ls
```

```text
SURFACE   KIND       AGE   IDLE  TOK     MUX    TASK / KEY
discord   channel    14m   2m    18420   none   summarizing the incident thread
telegram  channel    3m    3m    900     none   quick lookup
claude    cli        41m   0s    76210   tmux   refactor trust store
```

Backed by `GET /api/sessions?active=1` on the collector. This is the flat "who's alive right now"
roster.

## `asmltr map` — grouped by the repo they're **actively working in**

```bash
asmltr map
```

```text
/root/projects/personal/asmltr   ⚠ 2 agents — possible collision
   claude       Refactoring the trust store    · 3m ago · ./core/src(4) ./core
   discord  eve Answering a question on sessions · 8m ago · ./docs
/root/projects/client/site       1 agent
   telegram     Fixing the site header         · 1m ago · ./themes/main
```

Each line is **what** an agent is doing and **where**. "What" is the session's live activity rollup
(an AI summary refreshed from its recent inbound + **all** tool events, incl. shell), falling back to
its title, then its task label. "Where" is the **git repo it's actually working in**, mined from the
absolute paths in its recent tool activity.

How it's computed (`GET /api/map` in `insights/collector/server.js`):

1. Take active sessions, and their tool events from the last 30 minutes (`?since=` overrides).
2. Pull absolute paths out of each tool: explicit args (`file_path`, `notebook_path`, `path`) **and**
   paths mined from shell commands (`cd`, `git -C`, file args) — so a shell-heavy session isn't
   invisible. Each path is resolved up to its enclosing **git repo root** (walks up to `.git`).
3. Attribute each session to the repo it hit most; list its top sub-directories for context.
4. Sessions with no minable file activity fall back to their spawn `working_dir` (terminal sessions)
   or their channel location — so **every currently-active agent appears**, not only file-editors.
5. Group sessions by repo.

!!! tip "The ⚠ is a collision radar"
    Any repo with **more than one** agent working in it is flagged
    `⚠ N agents — possible collision`. That's your cue to check whether they're about to step
    on each other (use `asmltr who <path>` to zoom in, or drop an
    [announcement](announcements.md) to claim a file).

`map` is also the right tool to answer *"what's happening in the other sessions right now?"* — it
returns a live what/where line per active agent, not just a collision flag.

## `asmltr who <path>` — who recently touched a file or dir

```bash
asmltr who /root/projects/personal/asmltr/core/src/sessions.js
asmltr who core/src           # a directory works too — matches anything under it
```

```text
sessions that recently touched "core/src":
  claude      3m ago   7 hits  claude:cli:9f2a…
     Edit: {"file_path":"…/core/src/sessions.js"}
  discord     22m ago  1 hits  discord:main:channel:123…
     Read: {"file_path":"…/core/src/server.js"}
```

Backed by `GET /api/who?path=<p>`: it scans tool events from the last 6 hours whose payload
contains that path substring, groups them by session, and returns each session's hit count, last
timestamp, surface, and a sample tool call. Use it right before editing a shared file to see if
someone else is already in there.

## Coverage boundary — what these can and can't see

!!! warning "asmltr sees the sessions it observes — not every `claude` on the box"
    `ls`, `map`, and `who` are built from the collector's event stream, so they cover:

    - **channel turns** — Discord / Telegram / MCP / GitHub sessions run through the core (the
      core emits inbound/tool/outbound events for each turn);
    - **`asmltr claude` sessions** — interactive Claude Code sessions launched through the asmltr
      wrapper, whose transcripts are tailed into the collector.

    They do **not** see a **legacy, externally-launched `claude`** — one you started with a bare
    `claude` command outside asmltr. It emits nothing to the collector, so it won't show up in
    `ls`, won't appear on the `map`, and won't be found by `who`. If you want a session on the
    radar, start it with `asmltr claude` (or route it through a channel).

## The toolbelt in every system prompt

Unless `ASMLTR_SELF_AWARE=off`, the core appends an **ASMLTR TOOLBELT** block to every session's
system prompt so the model knows this toolbelt exists and is expected to use it. Verbatim, the
awareness portion reads:

> `asmltr ls` (active sessions) · `asmltr map` (grouped by working dir) · `asmltr who <path>`
> (who recently touched a file/dir) — **check these before duplicating work another session is
> already doing.**

The same block also advertises [`asmltr send`](cross-channel.md) (cross-channel delivery) and
[`asmltr announce`](announcements.md) (cross-session notes), pointing the model at `asmltr help`
for the full set. The intent is a self-reflecting multi-session setup: a session can notice its
peers, avoid stepping on them, coordinate, and route output — all from inside a normal turn using
the Bash tool.

## Where it lives

| Piece | File |
|---|---|
| `asmltr ls` / `map` / `who` verbs | `cli/asmltr.js` (`cmdLs`, `cmdMap`, `cmdWho`) |
| `GET /api/sessions` (active roster) | `insights/collector/server.js` |
| `GET /api/map` (repo grouping from tool paths) | `insights/collector/server.js` |
| `GET /api/who` (path → sessions) | `insights/collector/server.js` |
| ASMLTR TOOLBELT system-prompt block | `core/src/server.js` (`handle()`) |

## See also

- [Cross-session announcements](announcements.md) — leave a note so peers know what you own.
- [Cross-channel send (copy & redirect)](cross-channel.md) — deliver output through another
  connector.
- [Session steering & injection](injection.md) — an operator reaching into a live session.
