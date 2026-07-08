# OpenAI-compatible connector

The OpenAI connector (`connectors/types/openai/index.js`) exposes an asmltr install as an
**OpenAI-compatible REST API**. Point any OpenAI-style client — the official SDKs, chat UIs like
LibreChat, or an OpenRouter-style router — at the install and it's answered by the local Agent SDK
through the core, with the same trust + moderation as every other channel.

It serves:

- **`POST /v1/chat/completions`** — non-streaming JSON *and* SSE streaming (`stream: true`).
- **`GET /v1/models`** — advertises a single model id (`model_name`).
- **`GET /health`** — unauthenticated health check.

!!! note "No provider key — it rides your subscription"
    There is **no execution API key** here. The connector runs the local Agent SDK on your Claude
    subscription. The Bearer key a client sends is asmltr's *own inbound auth*, not a provider
    key — it maps the caller to a trust identity so moderation and authorization apply per caller.

---

## Authentication

Callers send `Authorization: Bearer <key>`. Keys map to a trust identity in a **gitignored**
`keys.json` beside the connector (copy from `keys.example.json`):

```json
{
  "keys": [
    { "key": "sk-asmltr-CHANGE-ME-long-random-string", "identity": "owner", "username": "openai-client" }
  ]
}
```

Each `identity` must be seeded as a principal in the trust store, or the caller is default-denied.
Set `require_key: false` to run open (callers resolve to an anonymous identity) — only sensible
behind your own auth.

---

## Stateful session model

This is a **stateful** chat endpoint. The core session holds history and resumes, so a conversation
maps to a stable `conversation_key`:

```
openai:<instanceId>:<sha1(identity + first-user-message)>
```

- The **first** request the connector sees for a key forwards the *whole* transcript the client
  sent (so any pre-existing history is included).
- **Every request after that** forwards only the **latest** user message — the core session already
  holds the history, so re-sent history past the latest turn is ignored.

Most OpenAI clients (which append to a message list and re-send the whole thing each turn) work
naturally with this: they keep appending, and the connector resumes the same core session, which
shows as one card on the dashboard.

!!! note "Conversation identity"
    Because the key seeds off the identity plus the *first* user message, a genuinely new
    conversation should start with a fresh opening message; reusing an identical first message
    resumes the earlier session.

Any `system` messages in the request are passed through as extra system prompt for that turn.

---

## Configuration

Discoverable live at `GET /types` on the manager. From the connector's `configSchema`:

| Field | Default | Purpose |
|---|---|---|
| `port` | `3025` | HTTP port. |
| `bind_host` | `127.0.0.1` | Bind address. |
| `model_name` | `asmltr` | Advertised model id (what `/v1/models` returns and responses echo). |
| `require_key` | `true` | Require a Bearer API key. |
| `keys_file` | `keys.json` (beside the connector) | Gitignored key → trust-identity map. |

This connector is request/response only — it declares `outbound: false`, so it is not a `POST /send`
target.

---

## Example request

```bash
curl -s http://127.0.0.1:3025/v1/chat/completions \
  -H 'Authorization: Bearer sk-asmltr-CHANGE-ME-long-random-string' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "asmltr",
    "messages": [
      { "role": "user", "content": "Summarize the architecture of this project." }
    ]
  }'
```

Add `"stream": true` to receive the reply as an OpenAI-style SSE stream
(`data: {...}` chunks terminated by `data: [DONE]`).

---

## Create an instance

```bash
curl -s -X POST 127.0.0.1:3024/instances -H 'Content-Type: application/json' -d '{
  "type":"openai",
  "name":"my-openai-api",
  "enabled":true,
  "config":{
    "port":3025,
    "bind_host":"127.0.0.1",
    "model_name":"asmltr",
    "require_key":true
  }
}'
```

See [Connectors](index.md) for the full manager API.
