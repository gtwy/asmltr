# Quick Start

You've finished [Installation](install.md): all packages installed, `.env` configured, trust seeded, and the three host services (`asmltr-core`, `asmltr-insights-collector`, `asmltr-connector-manager`) running under PM2. Now let's connect a channel and see a real message flow through.

## 1. Add a channel instance

The connector **manager** (`127.0.0.1:3024`) owns instances. Create one per channel. Here's a Discord example:

```bash
curl -s -X POST 127.0.0.1:3024/instances -H 'Content-Type: application/json' -d '{
  "type":"discord","name":"main","enabled":true,
  "config":{
    "bot_token_bws_key":"discord_bot_token",
    "dm_allowed_user_id":"<your discord id>"
  }
}'
```

!!! note "Secret key names, not secret values"
    `bot_token_bws_key` is the **name of a secret** the provider resolves — `discord_bot_token` maps to the `DISCORD_BOT_TOKEN` in your `.env` (UPPER_SNAKE of the key). It is never the token itself.

`GET /types` returns each connector type's full config schema — consult it for all options, and see [Connectors](https://github.com/jarethmt/asmltr/blob/main/connectors/index.md) for per-channel guides. To change an instance later, `PATCH /instances/<id>` with the **full merged** `config` object (partial configs are rejected).

Confirm the instance came up:

```bash
curl -s 127.0.0.1:3024/instances | head -c 400; echo
curl -s 127.0.0.1:3024/instances/<id>/logs | tail -c 400   # should show started/online
```

## 2. Send a real message

From your **owner identity** (the one you seeded into the trust store), send the assistant a DM or mention on the channel you just added. You should get a reply.

!!! tip "No reply?"
    - **"no bot token" / secret is null** → the `*_bws_key` doesn't resolve. Check the matching token is in `.env`, then restart the instance: `curl -X POST 127.0.0.1:3024/instances/<id>/restart`.
    - **Replies but declines everything / "no access"** → your identifier for that surface isn't a seeded principal. Fix `seed.json`, then `node core/src/trust/seed.js --force`.
    - **Core exits immediately** → the `claude` CLI isn't logged in. Run `claude` once interactively to confirm auth, then `pm2 restart asmltr-core`.

## 3. Watch it live

Use the CLI to see the session and event stream:

```bash
asmltr ls          # list active sessions
asmltr             # open the full live TUI (sessions + event log + system)
```

Watch one session as it runs:

```bash
asmltr watch discord:guild:<id>
```

See the [CLI reference](../cli.md) for the full command set (steer, takeover, coordinate, and more).

## Next steps

- Add more channels — Telegram, [MCP](https://github.com/jarethmt/asmltr/blob/main/connectors/mcp.md), GitHub, or an OpenAI-compatible endpoint. See [Connectors](https://github.com/jarethmt/asmltr/blob/main/connectors/index.md).
- Stand up the [web dashboard](../deployment/dashboard.md) for a browser-based view (behind authentication).
