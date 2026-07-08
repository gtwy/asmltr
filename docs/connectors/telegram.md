# Telegram connector

The Telegram connector (`connectors/types/telegram/index.js`) is a **1:1 bot**: one Telegram bot
token, a single authorized user (or a small allowlist), with incoming photos delivered to the model
as native vision. It's a thin transport — polling, photo download, and outbound send — over the
shared core.

---

## How it works

- **Polling.** The connector holds the bot token and long-polls Telegram for messages.

    !!! warning "One poller per token"
        Only one process may poll a given bot token at a time. If you're migrating from another
        bot on the same token, stop the old one before enabling this instance.

- **Authorization.** If `allowed_chat_ids` is set, only those chat ids are answered; anyone else
  gets `🔒 Access denied.`. If the list is **empty**, the bot *learns* the first chat that messages
  it and answers only that chat thereafter — the simplest setup for a single-user bot.
- **Photos → vision.** An incoming photo is downloaded, saved to `photo_dir`, and (if ≤ 5 MB)
  attached to the envelope as a native image so the model actually *sees* it. Larger images fall
  back to a note pointing the model at the saved file path.
- **Typing + chunking.** The bot shows a typing indicator while the turn runs and splits long
  replies into multiple messages to stay under Telegram's per-message limit.
- **Outbound HTTP.** The instance also runs a small HTTP server on `http_port` (default `3008`,
  bound to `127.0.0.1`) exposing `/send`, `/send-photo`, `/send-document`, and the unified `/out`
  endpoint the manager's `POST /send` router calls. This is how outbound alerts and file/photo
  delivery reach the channel.

The connector declares `supports_attachments_out: true`, so the core knows it can deliver photos
and documents outbound.

---

## Conversation key

```
telegram:<instanceId>:user:<userId>
```

One core session per authorized user, so the conversation is continuous across messages.

---

## Configuration

Discoverable live at `GET /types` on the manager. From the connector's `configSchema`:

| Field | Default | Purpose |
|---|---|---|
| `bot_token_bws_key` | — | Secret key name for the bot token (**required**). Resolved at runtime via the secret provider. |
| `allowed_chat_ids` | `[]` | Allowed chat ids. Empty = learn the first chat that messages the bot (single-user bots). |
| `http_port` | `3008` | Outbound HTTP port (bound `127.0.0.1`). |
| `photo_dir` | `~/.asmltr/telegram-photos` | Where incoming photos are saved. |

!!! note "The token is a secret key name, not the token"
    `bot_token_bws_key` names a secret in your configured secret store — it is **not** the raw
    token. The connector resolves it through `ctx.secrets.get(...)` at start.

---

## Create an instance

```bash
curl -s -X POST 127.0.0.1:3024/instances -H 'Content-Type: application/json' -d '{
  "type":"telegram",
  "name":"my-telegram-bot",
  "enabled":true,
  "config":{
    "bot_token_bws_key":"telegram_bot_token",
    "allowed_chat_ids":[123456789]
  }
}'
```

Leave `allowed_chat_ids` off (or `[]`) to let the bot lock onto the first chat that messages it.

See [Connectors](index.md) for the full manager API (patch, restart, logs, delete).
