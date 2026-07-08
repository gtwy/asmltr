# What is asmltr?

**asmltr is one channel-agnostic backend behind every chat surface for a single AI assistant — with a live insights dashboard.**

Run *one* assistant and let people reach it from **Discord, Telegram, an MCP client, GitHub issues, or any OpenAI-compatible client** — all through the same brain. Every surface shares one memory, one trust/permission model, one moderation screen, and per-secret output redaction. A collector plus dashboard give you a single pane of glass over everything the assistant is doing.

!!! note "The assistant runs on your Claude subscription"
    Execution is **local**, through the Claude Agent SDK (`@anthropic-ai/claude-code`) — the same auth Claude Code uses. There is **no `ANTHROPIC_API_KEY` execution path**: an API key would switch to metered billing and a sandbox with no local filesystem, project context, or skills.

!!! warning "Scope: asynchronous chat channels + monitoring"
    asmltr is deliberately scoped to **asynchronous chat channels and observability**. It is not a voice-assistant framework — though the Discord connector does have an optional voice mode.

## The key ideas

- **Thin connectors, one core.** A *connector* is pure I/O: it knows *how* its channel works (tokens, polling, message shapes) and nothing else. Everything shared — identity resolution, trust, prompt-building, moderation, session management, execution, and redaction — lives in the **core**. Adding a channel means writing one adapter that emits a normalized envelope and renders a reply.

- **One brain, one memory.** Every channel feeds the same core pipeline: `resolve identity/trust → build system prompt → moderate → conversation_key → session → run the turn (local Agent SDK) → redact secrets on public output → outbound actions`. Sessions are keyed per conversation, so context follows the conversation, not the connector.

- **Trust is default-deny.** No one has access until they are seeded into the trust store (or added via the dashboard's Access page). Each principal carries capability grants; full-trust principals can bypass moderation.

- **Moderation on every inbound message.** An LLM security screen runs before execution, stricter for low-trust principals.

- **Per-secret output redaction.** Tokens, keys, passwords, and private keys are masked from replies on public surfaces (and for any non-full-trust recipient). A private DM with a full-trust owner sees raw output.

- **Observability built in.** The core emits a shared event stream to a **collector**, which the **dashboard** and the **`asmltr` CLI/TUI** both read — live sessions, a cross-surface timeline, usage, and the trust Access page.

## Components at a glance

| Component | What it does | Runs as |
|---|---|---|
| `core/` (**asmltr-core**) | The channel-agnostic backend: envelope pipeline, sessions, trust, moderation, execution, redaction. | Host process (PM2), `127.0.0.1` |
| `connectors/` | The connector **manager** (supervisor + config API) and the connector **types** (`discord`, `telegram`, `mcp`, `github`, `openai`). Each enabled instance runs as its own child process. | Host process (PM2), `127.0.0.1` |
| `insights/collector/` (**asmltr-insights-collector**) | Telemetry collector: ingests the event stream, samples metrics, serves REST + socket.io. | Host process (PM2), `127.0.0.1` |
| `insights/dashboard/` | Vue 3 observability GUI. | Static build behind your own proxy/auth |
| `cli/` (**`asmltr`**) | Terminal client + live TUI over the collector API. | Host CLI |

## Who it's for

asmltr is for anyone running a personal or team AI assistant who wants **one assistant reachable from many places** instead of a separate bot per channel — with a unified permission model, moderation, and a live view of what the assistant is doing. It expects a host you control (the core spawns the local `claude` binary and signals host pids) and a Claude subscription for execution.

## Next steps

1. [Installation](install.md) — prerequisites, install every package, configure `.env`, seed trust, start the services.
2. [Quick Start](quickstart.md) — add your first channel and send a real message.
3. [Connectors](https://github.com/jarethmt/asmltr/blob/main/connectors/index.md) — the architecture and each channel's config.
4. [Deploying the web dashboard](../deployment/dashboard.md) — the observability GUI, behind authentication.
