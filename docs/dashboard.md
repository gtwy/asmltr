# The insights dashboard

A Vue 3 single-page app that sits over the collector as the single pane of glass for
every agent session, event, token, and host sample the backend records — and, unlike
the read-only early builds, it can now **take over** a live session.

It's a static build served behind a reverse proxy that forwards `/api` and
`/socket.io` to the collector, with auth applied at the edge. See
[Dashboard deployment](deployment/dashboard.md) for serving it in production.

---

## Views

The SPA is organised into a handful of routed views:

| Route | View | Shows |
|---|---|---|
| `/` | **Live** | Session cards across every surface, with click-through to conversation details + takeover. |
| `/timeline` | **Timeline** | Unified reverse-chronological cross-surface event feed; surface/identity filter chips + search; live-appends from the socket. |
| `/usage` | **Usage** | Token usage + attribution — stacked area and bar by surface, per-identity table. Framed as *attributed, not billed* for subscription surfaces. |
| `/system` | **System** | Live CPU %, load 1/5, memory, and disk charts plus current stat tiles. |
| `/notifications` | **Notifications** | Feed of outbound notifications. |
| `/connectors` | **Connectors** | Comms-channel connector instances — add/edit/restart/logs, per-Discord *Servers* (invite/leave). |
| `/integrations` | **Integrations** | Third-party service links (storage: webdav/s3/local) — add/configure/**test**; credentials stored in the [TRUST vault](integrations/index.md). |
| `/vault` | **Vault** | [TRUST vault](security/trust-vault.md) key management — status banner, keys (name·tier·access-count), add/delete. Values are write-only. |
| `/access` | **Access** | Access / identity. |

The header shows the **configured agent's name** (from Settings → Identity) over an "asmltr control
plane" subtext, and the whole UI — accent, gradients, background glow, nav logo, and browser favicon —
**retints in real time** from the identity's *signature palette* (Settings → Identity). So an agent's
own colours drive the surface it lives in.

The rest of this page focuses on the **Live** view, where the observe-and-control
loop lives.

---

## The Live view

### Summary and filters

At the top: stat tiles (active sessions, persistent daemons, live tokens, tokens over
24h) and a **surface distribution** row — one pill per active connector with its
session count.

- **Click a surface pill to filter** the session lists to that connector; click it
  again (or the `✕ clear` chip) to clear. Non-selected pills dim so it's clear
  what's active.
- **Content search** — the search box filters cards to sessions whose **content**
  (or metadata) matches a keyword. It debounces, then queries the collector's
  `/api/search` to find sessions with matching event text, and also matches against
  each session's title, location, identity, key, and task. Matching cards show a
  snippet of the hit. (Two-character minimum; a spinner shows while it searches.)

### Session cards

Sessions are split into **Ephemeral sessions** and **Persistent daemons**, each
sorted by most-recent activity. Each card carries:

- a **generated title** (the collector asks the core to summarise the conversation
  into a short label),
- the resolved **identity**,
- for Discord, the **origin** — server · channel,
- a **live activity preview** (the latest event for that session, streamed in), and
- **token** burn.

### Conversation details + takeover

**Click a card** to open the conversation-details pane. It shows the full history —
inbound / thinking / tool / tool-result / outbound, plus moderation and control
events — seeded from the collector and then live-appended from the socket, so it
keeps updating while open.

The footer is the **takeover** control:

- **Stop / Interrupt** — abort the session's in-flight turn. The session survives and
  stays resumable.
- a **steer text box** — type an operator message and **Send** to inject it into the
  session. For a channel session the reply **routes back to the origin channel**; for
  an interactive CLI (`asmltr claude`, tmux-backed) session it's **typed into the
  tmux pane** (and the pane's `tmux attach` command is shown so you can grab the
  terminal directly).

!!! note
    The dashboard mirrors the TUI's watch-view controls. For the full model of how
    steering routes back to a channel versus typing into a pane, see
    [Session steering & injection](coordination/injection.md).

### Per-channel monitor toggle (Discord)

Discord channel sessions carry a **monitor toggle** — on the card and in the detail
pane. It reads `● monitored` / `○ disabled` and flips the connector's per-channel
enable state live, via the connector manager. Disabling stops the bot from responding
in that channel; re-enabling resumes it. **No restart** — the change takes effect
immediately, and the dashboard refreshes channel state periodically so it stays in
sync with changes made elsewhere (e.g. the TUI's Channels panel).

---

## Serving it

The dashboard is a static Vite build (`dist/`). In development the Vite dev server
proxies `/api` and `/socket.io` to the collector on `:3017` — no CORS, no token, no
config. In production it's served behind a reverse proxy that forwards those same
paths to the collector and enforces authentication at the edge.

See [Dashboard deployment](deployment/dashboard.md) for the production setup.
