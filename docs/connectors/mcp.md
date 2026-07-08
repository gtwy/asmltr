# MCP connector

The MCP connector (`connectors/types/mcp/index.js`) exposes the assistant as a
**Model Context Protocol** server, so MCP clients (Claude Code, Claude web, and other MCP-aware
tools) can call it as a tool. It ships an OAuth 2.1 authorization server and both MCP transports.

---

## What it exposes

A single tool, `ask_<assistant>` (named `ask_oracle` on the wire), that forwards the caller's
question through the core and returns the reply. There is no hardcoded system prompt: the core's
trust framework and channel-awareness own identity, authorization, and medium-context. Each
authenticated client resolves to a trust identity, which flows through as the envelope sender.

### Transports

- **Streamable HTTP** (`/mcp`, POST) — the modern transport for fetch/undici-based clients (e.g.
  Claude Code). Stateless: identity comes from the OAuth token, conversation continuity from the
  core's per-user `conversation_key`. Because `ask_<assistant>` can run for minutes on a deep
  request, the response is streamed as SSE with periodic progress so the client's first-byte and
  idle timers don't fire.
- **Legacy HTTP + SSE** (`GET /sse` + `POST /message`) — the original transport for clients that
  hold an idle event stream open. One live SSE per user; a heartbeat keeps the stream warm.

Both require an OAuth bearer token. `GET /health` is unauthenticated.

---

## OAuth 2.1

The connector runs a full OAuth 2.1 authorization server (RFC 8414/9728/7636/8707, PKCE, a consent
page, token validation). It supports:

- **Discovery** — `/.well-known/oauth-protected-resource` and
  `/.well-known/oauth-authorization-server`.
- **Dynamic Client Registration** (RFC 7591) — `POST /oauth/register`.
- **Authorization / token** — `/oauth/authorize` (consent), `/oauth/approve`, `/oauth/token`.

Token storage is per-instance (`connectors/manager/data/mcp-tokens-<instanceId>.json`).

### Pre-registered clients → trust identities

Clients you control are pre-registered in a **gitignored** `clients.json` alongside the connector
(copy from `clients.example.json`). Each client's `identity` maps its OAuth login to a trust
principal — that `userId` becomes the envelope sender, so the core resolves trust from it. Unknown
clients resolve to `unknown` (default-deny).

```json
{
  "clients": [
    {
      "client_id": "my-claude-code-cli",
      "client_secret": "CHANGE-ME-long-random-string",
      "client_name": "My Claude Code CLI",
      "redirect_uris": ["http://localhost/callback", "http://127.0.0.1/callback"],
      "identity": { "userId": "teammate", "username": "teammate" }
    }
  ]
}
```

!!! warning "Seed the mapped identity in the trust store"
    A client's `identity.userId` must exist as a principal in the trust store, or its calls are
    default-denied. Pre-registering the client is not the same as granting it trust.

!!! tip "Override the clients file location"
    Set `ASMLTR_MCP_CLIENTS_FILE` to point at a `clients.json` outside the repo.

---

## Conversation key

```
mcp:<instanceId>:user:<userId>
```

One core session per OAuth identity, so repeated tool calls from the same client continue the same
conversation.

---

## Configuration

Discoverable live at `GET /types` on the manager. From the connector's `configSchema`:

| Field | Default | Purpose |
|---|---|---|
| `port` | `3018` | HTTP port. |
| `bind_host` | `127.0.0.1` | Bind address. |
| `base_url` | `https://mcp.example.com` | Public base URL (advertised in OAuth metadata + `WWW-Authenticate`). |

!!! note "Binding for a reverse proxy"
    Default binds `127.0.0.1`; a reverse proxy fronts the public `base_url`. If your proxy lives on
    a Docker bridge network, you can bind the bridge gateway IP (e.g. `172.18.0.1`) instead of
    `0.0.0.0` so the port is reachable by the proxy without being exposed on the host's public NIC.

---

## Create an instance

```bash
curl -s -X POST 127.0.0.1:3024/instances -H 'Content-Type: application/json' -d '{
  "type":"mcp",
  "name":"my-mcp",
  "enabled":true,
  "config":{
    "port":3018,
    "bind_host":"127.0.0.1",
    "base_url":"https://mcp.example.com"
  }
}'
```

See [Connectors](index.md) for the full manager API.
