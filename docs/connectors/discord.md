# Discord connector

The Discord connector (`connectors/types/discord/index.js` + `voice.js`) is the richest asmltr
channel. It handles text chat (mention + autonomous participation), multi-agent group chats, an
`@mention`-driven command system, and an optional **voice mode** (join a voice channel, transcribe,
answer out loud). Everything below is per-instance config on the connector; the assistant's *brain*
is still the shared core.

---

## First-time setup: create the application, bot, and token

Before asmltr can run a Discord instance, you need a Discord **application** with a **bot** and its
**token**. This is a one-time job in the
[Discord Developer Portal](https://discord.com/developers/applications), and it comes before the
invite step below.

1. **New Application**, then name it. This name is the identity people see in Discord.
2. Open the **Bot** tab. Under **Token**, click **Reset Token** and copy it once (Discord shows it a
   single time). Store it where your `bot_token_bws_key` resolves: with the default key
   `discord_bot_token`, that means `DISCORD_BOT_TOKEN=<token>` in `.env`.
3. Enable the **Message Content** intent (next section). This is the step most setups miss.

### Enable the Message Content intent (required)

On the **Bot** tab, under **Privileged Gateway Intents**, turn **MESSAGE CONTENT INTENT** on & save.

The connector requests it (`GatewayIntentBits.MessageContent` in
`connectors/types/discord/index.js`), and Discord refuses the gateway connection for a privileged
intent the application hasn't enabled. Leave it off & the instance fails to start with
`Used disallowed intents` in its logs and restart-loops; a bot that does connect without it reads
**empty** message text, so every message looks blank & it silently never replies. This is the single
most common reason a fresh Discord bot looks dead. Turn it on, then start or restart the instance.

- **MESSAGE CONTENT INTENT** — **required.** Without it the bot reads no message text.
- **SERVER MEMBERS** & **PRESENCE** — not used by the connector; leave them off.

A bot in 100+ servers needs Discord to verify the application before this intent unlocks; a personal
or single-server bot toggles it freely.

### Direct messages need a shared server

A Discord bot can only DM a user who already shares a server with it. So `dm_allowed_user_id` takes
effect only once the bot & that user are both in a common server (a private one-person server is
enough). Invite the bot (next section) first, then open a DM with it.

---

## Adding / removing the bot from a server

**Adding the bot to a Discord server is a Discord OAuth authorization, not an asmltr config change.**
One bot token drives one Discord application, and that application serves *every* server it's a
member of. So you don't "configure a server" in asmltr — you invite the bot, and the running
connector sees the new guild over the gateway **instantly, with no restart**.

**The easy way (dashboard):** Integrations → the Discord instance card → **Servers**. The modal shows
the **invite URL** (copy or open it) and every server the bot is already in, each with a **Leave**
button. Open the invite as someone with **Manage Server** on the target, authorize, and the bot joins.

**By hand:** build the invite URL from the application (client) ID + a permission integer:

```
https://discord.com/api/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot%20applications.commands&permissions=<PERMS>
```

- **Application ID** — the bot's application/client ID (Discord Developer Portal → your app → General
  Information, or the numeric ID the dashboard's Servers modal shows).
- **Permissions** — asmltr's default `3525696` covers view/send/read-history/embed/attach/react/
  external-emoji plus voice connect + speak. Adjust in the Developer Portal's OAuth2 URL Generator if
  you want a narrower or wider set.
- **Scopes** — `bot` is required; `applications.commands` future-proofs slash commands.

The connector also exposes this over its control API (proxied by the manager):

```
GET  /instances/<id>/servers          # → { invite_url, application_id, servers: [{id,name,member_count}] }
POST /instances/<id>/servers { "leave": "<guildId>" }   # bot leaves that server
```

**Removing:** click **Leave** in the Servers modal, `POST …/servers {leave}`, or — from Discord —
Server Settings → Members → kick the bot. Leaving is immediate; the gateway drops the guild.

> Per-channel monitoring (which channels it actually listens in once it's in a server) is separate —
> see **Channel enable/disable** below.

---

## Invite-only servers (trust)

The current Discord path is for **invite-only** servers — people you let in. That includes silo
access, `observe_only` context on the next @, and `announce *`. A truly public or open Discord
(anyone can join, no invite gate) is **not trusted yet**. Do not treat this connector as safe on
an open server.

---

## Message flow — when does it respond?

Every message runs through this gauntlet in `messageCreate` (first `return` wins). Understanding the
order explains all the behavior:

1. **Own message** → ignore (`author.id === bot`).
2. **Voice artifact** → ignore any message starting with `🗣️`/`🔊` (transcripts / spoken-reply mirrors
   that *any* agent posts for its own voice session — never conversation for another agent).
3. **Bot filter** → ignore messages from other bots **unless** the sender is in `allowed_bot_names`
   (or `engage-all-bots` mode is on). Humans always pass.
4. **Commands** (`handleControlCommands`) → if the message `@mentions` the bot (or a role it holds)
   and the text is a recognized command, run it and stop. See [Commands](#commands).
5. **Disabled channel** → if this channel is disabled (via `mute`, the TUI, or an allowlist default),
   ignore everything except the commands above. See [Channel enable/disable](#channel-enabledisable--control-what-it-listens-to).
6. **Voice-session suppression** → while it's in an active voice session in this guild, it answers
   by *voice* only; non-`@mention` text is dropped (prevents a doubled spoken + text reply).
7. **Directed at another agent** → if `ignore_other_mentions` (default on) and the message `@mentions`
   another user/bot **or leads with another agent's name** ("some-other-bot, …") and *not* the assistant → ignore.
   (Plain names aren't real Discord `@`-mentions, so both cases are checked.)
8. **Guild ACP session** → unmuted guild channels start **asleep**. A real Discord `@mention` ping
   (not a bare name) wakes the session. While awake the connector reads the channel, queues inbound
   messages in receive order (no barges), and lets the model decide whether to speak. A bare re-ping
   does not spawn a new session. `@mention stop` while typing is a hard kill (starter or owner);
   `@mention stop` while idle-awake is a gentle sleep (anyone). After 10 minutes with nothing worth
   a reply the session sleeps and posts 😴. DMs are always ACP and skip this machine.
9. **Silenced** → legacy mention-only toggle (DMs / leftover autonomous path).

Two more guards apply when it *does* generate a reply:

- **Self-gating** — the core prompt tells it, in a multi-agent room, to emit only the token
  `[[NO_REPLY]]` if a message isn't actually for it; the connector then drops the reply silently.
- **Dedup** — it never re-posts a reply verbatim-identical to one of its last ~6 in that channel
  (guards against rare replays in long resumed sessions).

---

## Commands

Commands are **`@mention`-driven** (universal — no hardcoded name). Address the bot directly
(`@Bot <command>`) **or** `@mention` a role the bot holds (so one ping commands *every* agent in that
role at once). Anything after the mention that isn't a recognized command is treated as a normal message.

| Command | Effect | Who |
|---|---|---|
| `silence` / `speak` | mention-only mode ↔ autonomous (legacy; guild ACP uses sleep/wake) | owner |
| `mute` / `unmute` (aka `disable` / `enable`) | ignore **this channel** entirely ↔ resume (persisted) | owner |
| `engage-all-bots` / `disengage-all-bots` | hear **all** bots ↔ only the `allowed_bot_names` list (persisted) | owner |
| `join-voice` / `leave-voice` | **join-voice is off** until rebuilt; leave-voice still disconnects | owner |
| `stop` | typing + `@mention stop`: kill the in-flight turn (starter or owner). Awake/idle + `@mention stop`: gentle sleep (anyone) | see who |
| `status` | show silenced / bot-mode / this-channel / ACP session state | anyone |
| `help` | list commands | anyone |

**Owner** = a principal with `bypass_moderation` (full trust) in *this bot's own trust store* —
resolved live via the core's `/trust/resolve`. So each agent knows its own owner; nobody else can
run the state-changing commands. State (`mute`, `engage-all-bots`) persists in
`connectors/manager/data/discord-<id>-settings.json`.

## Channel enable/disable — control what it listens to

New Discord channels default **muted** until the owner unmutes them (`channelCreate` writes an
explicit off). The persisted per-channel map is not rewritten. Two ways to scope listening, both
**per-channel and persisted**, both meaning *fully ignored — no relay to core, no usage* (owner
`@mention` commands still work in a disabled channel so you can re-enable it):

- **Allowlist (schema default):** `channels_default: false` — ignore every channel except ones you
  enable. New channels stay muted until unmuted.
- **Blocklist:** `channels_default: true` (or a persisted `channelsDefault: true`) — listen
  everywhere except explicit mutes. Existing installs that already persisted that flag keep it.

**From the TUI/GUI (no restart):** in `asmltr` press **`c`** for the channels view — every channel
each connector can reach, grouped by instance, with its on/off state. `SPACE`/`ENTER` toggles the
selected channel, `d` flips that instance's default (blocklist ↔ allowlist), `r` reloads, `ESC` exits.

**Over HTTP:** the connector exposes `GET /channels` and `POST /channels {channel_id, enabled}` (or
`{channel_id, clear:true}` to drop an override back to default, or `{default_enabled}` to flip the
mode) on its `http_port`; the manager proxies these as `GET|POST /instances/<id>/channels` so the
TUI/dashboard can drive any connector uniformly. Changes take effect immediately — no reconnect.

Mute/disable is **inbound only**. The bot will not *listen* in a muted channel (except owner
`@mention` commands). Outbound same-guild post into that channel still works.

---

## Same-guild post (`asmltr send discord`)

Public Discord **always** denies cross-system `asmltr send` (email, Telegram, other Discord
servers). Same-server posting uses the same verb:

`asmltr send discord <id-or-name> "<text>"` (MCP `asmltr_send`).

| Rule | What |
|---|---|
| Who | Owner, trusted role, or `resolve()` allow (`guild-post` / `send` / `*`). `default_tier` is a schema field, not the send gate. Empty roles cannot. |
| Where | This Discord server only. No DMs, no email, no other guilds. |
| Same channel | Skipped — answer in the ask channel instead. |
| Name vs id | A name (`the 666 degree steak thread`) **looks up** and does not post. Confirm with the person, then call again with the snowflake. |
| Text channel | Posts **in the channel**, not a thread. |
| Forum | Thread id = comment on that post. Forum channel id = **new** forum post (pass `--title`). |
| Mute | Destination mute does not block the post (inbound-only). |
| Body | Prefixed `Posting on behalf of <@asker>` then two blank lines. No thought chips on the remote post. |
| After a real post | Ask channel gets `Post complete.` — then `[[NO_REPLY]]`. |

Recommended seed + allowlist (placeholders only): `core/src/trust/seed.example.json` (example `friend` principal) and `shared/media-allow.example.json`.

---

## Multi-agent group chats

Several agents can share a channel. Key knobs:

- **`allowed_bot_names`** — usernames of *other* agents this bot should hear (else all bots are
  ignored). Reciprocal: for A↔B, A must list B *and* B must list A.
- **`engage-all-bots`** command — skip the allowlist and hear every bot (relies on `[[NO_REPLY]]`
  self-gating + rate limits to stay sane). `disengage-all-bots` reverts.
- **`ignore_other_mentions`** (default true) — a message directed at a *specific other* agent
  (`@Other` or leading "Other, …") is dropped, so a single-agent question only wakes that agent.
- **Transcript-ignore** — agents skip each other's `🗣️`/`🔊` voice lines.
- **Rate limits** — `min_response_interval_ms` (default 10s between autonomous replies) and
  `max_responses_per_hour` (default 20/channel).

---

## Guild ACP session

Discord **text** ingress (DM + unmuted guild) always runs on the ACP engine (Grok). STANDARD
(Claude SDK) stays in the tree for email, GitHub, schedules, and voice. Thought chips are off in
guild channels. Effort in general channels is locked to **medium**. `^` anywhere in a wake or
follow-up asks for scrollback / older photo lookup.

Channel tools on for everyone: web, discord search + photo dig, reply, guild-post (tag the
requester), image generate + attach, relay to the operator. Off for everyone in channel (including
the operator): shell, streams, write, uploads, arbitrary email. Card roles `trusted` / `email` /
`mail` may email on-file peers only. If the operator asks for something the room cannot do, the
model refuses in-channel and hands the question to a private DM (`[[HANDOFF]]`).

---

## Voice mode

`join-voice` is **fully off** until rebuilt (not owner-only — off). Leave-voice and the voice
implementation remain in the tree. Optional rebuild needs **ffmpeg** and an OpenAI key (STT) +
optionally ElevenLabs (TTS). Set `ASMLTR_DISCORD_JOIN_VOICE=1` only when the rebuilt path is ready.

1. **`@Bot join-voice`** (while you're in a voice channel) → refused until rebuilt.
2. **Listening** — Discord gives a separate audio stream per speaker (free diarization). Each
   utterance is captured (silence-gated + energy-gated to skip noise), transcribed via OpenAI
   (`gpt-4o-transcribe`, language-locked, name-biased prompt), and posted as `🗣️ name: …`.
3. **Addressing it** — say its name (lead **or** trail: "Assistant, …" / "…, Assistant"). It chimes ("heard
   you"), plays a soft **"working" drone** while the turn runs, then **speaks** the reply (ElevenLabs)
   and mirrors it as `🔊 Name: …`.
4. **Follow-ups** — after it answers, follow-ups need **no wake word** for `voice_followup_ms`
   (default 45s, extends each exchange). No chime on follow-ups, just the drone.
5. **Dismissal** — "that's enough, Assistant" / "we're good" / "go back to listening" exits answering mode
   back to **transcription-only** (it stays in the channel).
6. **`@Bot leave-voice`** (or say "leave voice") → disconnect.

Voice replies run through the core's redaction (public), so it won't speak secrets aloud.

---

## Configuration (`meta.configSchema`)

Discoverable live at `GET /types` on the manager. Fields:

| Field | Default | Purpose |
|---|---|---|
| `bot_token_bws_key` | — | secret key name for the bot token (**required**) |
| `dm_allowed_user_id` | `""` | Discord user id allowed to DM the bot |
| `allowed_bot_names` | `[]` | other agents' usernames to engage |
| `ignore_other_mentions` | `true` | drop messages directed at another specific agent |
| `presence_text` | `""` | activity/status text |
| `min_response_interval_ms` | `10000` | min ms between autonomous replies |
| `max_responses_per_hour` | `20` | cap per channel |
| `http_port` | `3016` | outbound `/send-message` + `/out` HTTP port |
| `data_dir` | manager/data | memory + settings storage |
| `voice_id` | (default voice) | ElevenLabs voice for spoken replies |
| `elevenlabs_key_name` | `elevenlabs_api_key` | secret key name for ElevenLabs |
| `tts_model` | `eleven_turbo_v2_5` | ElevenLabs model |
| `stt_language` | `en` | voice STT language (empty = auto) |
| `voice_followup_ms` | `45000` | no-wake-word follow-up window |

Secrets consumed at runtime (via the secret provider): the bot token, `openai_api_key` (voice STT),
and the ElevenLabs key.

---

## Discord search (`asmltr discord-search`)

On for everyone in public guild ACP turns. Owner-private on DM / email / MCP.

`asmltr discord-search "<query>"` (MCP `asmltr_discord_search`) calls official
`GET /guilds/{guild.id}/messages/search` for **every guild the bot is in**. It does
**not** download channel history. Each hit gets a second hop
`GET /channels/{id}/messages?around=hit&limit=N` with **N ≤ 25**. The assistant's
own posts are included — do not filter bot/self messages.

Discord's index does not fold accents (`padron` and `padrón` are disjoint). The
wrapper expands each query into a small variant set — the original, an NFD-stripped
form, last-vowel acute (`padron` → `padrón`), last-n tilde (`anejo` → `añejo`), and
a mixed Spanish recombine (`pilon anejo` → `pilón añejo`) — searches each variant,
then merges and dedupes by message id (round-robin, still capped at 25 hits per
guild so around-hops stay bounded). DMs fold both the query and message text
locally in the capped window.

DMs are not guild search: pass `--dm --channel <dm-channel-id>` for a capped
around/before/latest window (never a full dump). Silo transcripts can cover older
DM text the host stored.

Needs **MESSAGE CONTENT** (already requested) and **READ MESSAGE HISTORY** (already
in the invite permission integer `3525696`). If Discord's search index is not
ready, the API returns **202** with `retry_after`; the wrapper retries a few times,
then tells you to wait.

Optional `--channel` is a search *filter* (still the search endpoint). Host INDEX /
workflows name preferred house channels for food and cigars — those ids stay off
this public tree.

---

## Memory & outbound

- **Memory** — hierarchical per-server/-channel history (last 200 msgs/channel + a 500-entry global
  timeline for cross-channel recall), persisted to `discord-<id>-memory.json`. On a **fresh** guild
  engine session (new session / resume after idle or core start), the connector re-injects last-N
  of **this** channel into the observe/catch-up preamble (`ASMLTR_DISCORD_GUILD_SCROLLBACK`, default
  **30**). Prefers `memory.json`; if that window is empty or stale, one
  `channel.messages.fetch({limit:N})` (optional `before` is a single extra page, not a dump).
  Not `asmltr_discord_search`. DMs still use PRIOR / conversation-first silo recall only.
  The *session* itself lives in the core (per-channel `conversation_key`).
- **Outbound** — declares `outbound` in `meta`, so the manager's `POST /send` can route messages out
  through it (used by admin alerts and any `/send` caller). Channel **aliases** map friendly names →
  channel ids via a gitignored `channel-aliases.json` (see `.example`).
