'use strict';
/**
 * asmltr connector type: DISCORD — full-feature port of eve-discord-bot.
 *
 * All Discord-specific behavior stays HERE (the plugin): hierarchical memory,
 * autonomous-participation logic, !eve control commands, code-block reformat +
 * chunking, and the /send-message HTTP endpoint (message-discord depends on it).
 * The LLM turn goes through asmltr-core: the rich Discord context + server-aware
 * authorization rides as `system_prompt_extra`; content.text is the clean user
 * message (so moderation + identity work correctly). Per-guild continuity comes
 * from the core's session resume (conversation_key), replacing the old per-server
 * session-ids file.
 *
 * conversation_key = discord:<instanceId>:guild:<guildId>  (DMs: :dm:<userId>)
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const { Client, GatewayIntentBits, Partials, ActivityType } = require('discord.js');

// Assistant identity — the display name AND the spoken wake word for voice.
const NAME = process.env.ASSISTANT_NAME || 'Assistant';
const WAKE = NAME.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // regex-escaped
// Self-gating sentinel: in a multi-agent channel the model emits ONLY this token when a
// message isn't meant for it, and the connector drops the reply instead of posting it.
const NO_REPLY = '[[NO_REPLY]]';
// Control commands that change the bot's behavior — restricted to the bot's owner.
const OWNER_ONLY_CMDS = new Set([
  'silence', 'be quiet', 'quiet', 'shush', 'speak', 'unsilence', 'wake up', 'resume',
  'mute', 'mute here', 'mute this channel', 'ignore this channel', 'disable', 'disable here',
  'unmute', 'unmute here', 'listen here', 'unmute this channel', 'enable', 'enable here',
  'engage-all-bots', 'engage all bots', 'engage all', 'disengage-all-bots', 'disengage all bots', 'disengage all',
  'drone-on', 'drone on', 'drone-off', 'drone off',
  'join-voice', 'join voice', 'join vc', 'join the voice', 'leave-voice', 'leave voice', 'leave vc', 'leave the voice',
  'update-asmltr', 'update asmltr', 'self-update', 'update yourself',
]);

const meta = {
  type: 'discord',
  displayName: 'Discord',
  supportsMultiple: true,
  capabilities: { max_message_chars: 2000, supports_markdown: true, supports_code_blocks: false, supports_attachments_out: true },
  credentialKeys: ['bot_token_bws_key'],
  // How the Access page presents identifiers for this surface (trust framework).
  identifierFormats: [{ surface: 'discord', label: 'Discord User ID', placeholder: '000000000000000000', pattern: '^\\d+$' }],
  outbound: { kinds: ['text', 'photo', 'file'], target: { required: true, label: 'Channel id or alias (e.g. TD-TSD-main)' } },
  configSchema: {
    type: 'object',
    required: ['bot_token_bws_key'],
    properties: {
      bot_token_bws_key: { type: 'string', title: 'Bot token (Bitwarden secret key)' },
      http_port: { type: 'integer', title: 'Send-message HTTP port', default: 3016 },
      dm_allowed_user_id: { type: 'string', title: 'Allowed DM user id', default: '' },
      min_response_interval_ms: { type: 'integer', title: 'Min ms between autonomous responses', default: 10000 },
      max_responses_per_hour: { type: 'integer', title: 'Max autonomous responses/hour/channel', default: 20 },
      data_dir: { type: 'string', title: 'Memory data dir', default: '' },
      voice_id: { type: 'string', title: 'ElevenLabs voice id (spoken replies)', default: '' },
      tts_model: { type: 'string', title: 'ElevenLabs TTS model', default: 'eleven_turbo_v2_5' },
      allowed_bot_names: { type: 'array', title: 'Bot usernames to engage (else all bots ignored)', items: { type: 'string' }, default: [] },
      presence_text: { type: 'string', title: 'Presence/activity text', default: '' },
      elevenlabs_key_name: { type: 'string', title: 'Secret key name for ElevenLabs (voice)', default: 'elevenlabs_api_key' },
      stt_language: { type: 'string', title: 'Voice STT language (ISO code; empty = auto-detect)', default: 'en' },
      voice_followup_ms: { type: 'integer', title: 'Voice follow-up window (ms) after being addressed, during which follow-ups need no wake word. 0 = STRICT: only respond when directly addressed by name (recommended for meetings).', default: 0 },
      voice_drone: { type: 'boolean', title: 'Voice: play a soft ambient drone while processing a spoken reply', default: true },
      ignore_other_mentions: { type: 'boolean', title: 'Ignore messages @-directed at other specific users/bots (keeps passive name-drops)', default: true },
      channels_default: { type: 'boolean', title: 'Listen in channels by default (false = allowlist: ignore every channel except ones you enable)', default: true },
    },
  },
  // Interactive settings panels this connector exposes beyond plain config — the TUI/GUI
  // renders each generically (a connector adds a panel by declaring it here + serving its
  // HTTP endpoint). `kind` selects the client-side renderer; `endpoint` is proxied by the
  // manager as /instances/<id>/<endpoint>. Channel toggles are LIVE (no restart).
  panels: [
    { id: 'channels', title: 'Channels — which channels I listen to', kind: 'channels', endpoint: 'channels' },
  ],
};

const STOP_WORDS = new Set(['the','a','an','and','or','but','is','are','was','were','in','on','at','to','for','of','with','by','from','as','that','this','it','be','have','has','had','do','does','did','will','would','can','could','should','may','might']);
const RELEVANT_TOPICS = ['consciousness','ai','artificial intelligence','machine learning','docker','traefik','architecture','obsidian','note taking','knowledge management','autonomous','autonomy','bot','discord'];

async function start(ctx) {
  const cfg = ctx.config;
  // Bots are ignored unless their username matches the allowlist — OR engage-all-bots
  // mode is on (a runtime toggle for multi-agent group chats; see the mention commands).
  const allowedBotNames = (cfg.allowed_bot_names || []).map((s) => String(s).toLowerCase());
  const isAllowedBot = (u) => !!u && (engageAllBots || allowedBotNames.some((n) => u.toLowerCase().includes(n)));
  const token = (await ctx.secrets.get(cfg.bot_token_bws_key)) || cfg.bot_token;
  if (!token) throw new Error(`no bot token (bws key '${cfg.bot_token_bws_key}')`);
  const dmUser = cfg.dm_allowed_user_id || '';
  const ignoreOtherMentions = cfg.ignore_other_mentions !== false; // drop msgs @-directed at OTHER specific users/bots
  const minInterval = cfg.min_response_interval_ms || 10000;
  const maxPerHour = cfg.max_responses_per_hour || 20;
  const dataDir = cfg.data_dir || path.join(__dirname, '..', '..', 'manager', 'data');
  const memoryFile = path.join(dataDir, `discord-${ctx.instanceId}-memory.json`);

  // channel aliases for unified outbound (TD-TSD-main → channel id)
  let aliases = {};
  try { aliases = JSON.parse(fs.readFileSync(cfg.aliases_file || path.join(__dirname, 'channel-aliases.json'), 'utf8')).aliases || {}; } catch (_) {}
  const resolveChannel = (t) => aliases[t] || t;

  // --- state ---
  let memory = { servers: {}, globalTimeline: [] };
  const processing = new Map();
  let silenced = false;
  let lastResponseTime = 0;
  const responseCount = new Map();
  const recentReplies = new Map(); // cid -> last few reply texts (dedup verbatim repeats)
  // persisted per-instance settings: per-channel enable/disable + engage-all-bots toggle.
  // channelStates holds EXPLICIT per-channel overrides (cid -> bool); channelsDefault decides
  // any channel without an override. default=true → "listen everywhere except disabled" (blocklist);
  // set channels_default:false in config → "ignore everywhere except enabled" (allowlist), for
  // bots sitting in big servers where only a couple of channels matter. A disabled channel is
  // fully ignored — no relay to core, no usage (mention-commands still work so you can re-enable).
  const settingsFile = path.join(dataDir, `discord-${ctx.instanceId}-settings.json`);
  const channelStates = new Map(); // channel_id -> boolean (explicit override)
  let channelsDefault = cfg.channels_default !== false; // unlisted channels: enabled unless config says otherwise
  let engageAllBots = false;
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    (s.mutedChannels || []).forEach((c) => channelStates.set(String(c), false)); // migrate legacy mutes
    if (s.channels && typeof s.channels === 'object') for (const [c, on] of Object.entries(s.channels)) channelStates.set(String(c), !!on);
    if (typeof s.channelsDefault === 'boolean') channelsDefault = s.channelsDefault;
    engageAllBots = !!s.engageAllBots;
  } catch (_) {}
  function channelEnabled(cid) { return channelStates.has(String(cid)) ? channelStates.get(String(cid)) : channelsDefault; }
  function saveSettings() {
    try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify({ channels: Object.fromEntries(channelStates), channelsDefault, engageAllBots })); }
    catch (e) { ctx.log('settings persist failed: ' + e.message); }
  }

  // --- memory load/persist (hierarchical; Sets serialized as arrays) ---
  try {
    const loaded = JSON.parse(fs.readFileSync(memoryFile, 'utf8'));
    if (!Array.isArray(loaded)) {
      memory = loaded;
      for (const s in memory.servers) for (const c in memory.servers[s].channels)
        memory.servers[s].channels[c].participants = new Set(memory.servers[s].channels[c].participants);
    }
  } catch (_) {}
  function persistMemory() {
    const out = { servers: {}, globalTimeline: memory.globalTimeline };
    for (const s in memory.servers) {
      out.servers[s] = { ...memory.servers[s], channels: {} };
      for (const c in memory.servers[s].channels)
        out.servers[s].channels[c] = { ...memory.servers[s].channels[c], participants: Array.from(memory.servers[s].channels[c].participants) };
    }
    try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(memoryFile, JSON.stringify(out, null, 2)); } catch (e) { ctx.log('persist failed: ' + e.message); }
  }
  function saveMemory(message, author, content) {
    const ts = new Date().toISOString();
    const sid = message.guild?.id || 'DM';
    const cid = message.channel.id;
    if (!memory.servers[sid]) memory.servers[sid] = { id: sid, name: message.guild?.name || 'Direct Message', joinedAt: ts, channels: {} };
    if (!memory.servers[sid].channels[cid]) memory.servers[sid].channels[cid] = { id: cid, name: message.channel.name || 'DM', messages: [], participants: new Set(), lastActivity: ts };
    const ch = memory.servers[sid].channels[cid];
    ch.messages.push({ timestamp: ts, author, content, messageId: message.id });
    if (ch.messages.length > 200) ch.messages = ch.messages.slice(-200);
    ch.participants.add(author); ch.lastActivity = ts;
    memory.globalTimeline.push({ timestamp: ts, serverId: sid, serverName: memory.servers[sid].name, channelId: cid, channelName: ch.name, author, content, messageId: message.id });
    if (memory.globalTimeline.length > 500) memory.globalTimeline = memory.globalTimeline.slice(-500);
    persistMemory();
  }

  function extractKeywords(text) {
    return text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length > 3 && !STOP_WORDS.has(w)).slice(0, 5);
  }
  function searchGlobalTimeline(content, exSid, exCid) {
    const kws = extractKeywords(content); if (!kws.length) return [];
    return memory.globalTimeline.filter(m => !(m.serverId === exSid && m.channelId === exCid) && kws.some(k => m.content.toLowerCase().includes(k))).slice(-10);
  }
  function getRelevantContext(message) {
    const sid = message.guild?.id || 'DM', cid = message.channel.id;
    const msgs = memory.servers[sid]?.channels[cid]?.messages || [];
    return {
      primary: msgs.slice(-10),
      crossContext: searchGlobalTimeline(message.content, sid, cid).slice(0, 3),
      location: { serverName: memory.servers[sid]?.name || 'Direct Message', channelName: memory.servers[sid]?.channels[cid]?.name || 'DM', participants: Array.from(memory.servers[sid]?.channels[cid]?.participants || []) },
    };
  }

  // --- autonomous participation (verbatim heuristics) ---
  function shouldRespondTo(message) {
    if (message.channel.type === 1) return message.author.id === dmUser; // DM: only the owner
    if (message.mentions.has(client.user)) return true;
    if (message.attachments.size > 0) return true;
    const now = Date.now();
    if (now - lastResponseTime < minInterval) return false;
    const cid = message.channel.id;
    if ((responseCount.get(cid) || 0) >= maxPerHour) return false;
    const sid = message.guild?.id || 'DM';
    const recent = (memory.servers[sid]?.channels[cid]?.messages || []).slice(-10);
    const content = message.content.toLowerCase();
    if (content.includes('?') && (content.includes(NAME.toLowerCase()) || content.includes('what do you') || content.includes('how do you') || content.includes('can you'))) return true;
    if (isAllowedBot(message.author.username)) return true;
    const mine = recent.filter(m => m.author === NAME).length;
    if (mine > 0 && mine <= 3) {
      if (recent.slice(-5).some(m => ['ai','consciousness','autonomy','obsidian',NAME.toLowerCase()].some(k => m.content.toLowerCase().includes(k)))) return true;
    }
    if (RELEVANT_TOPICS.some(t => content.includes(t)) && content.length > 20) return true;
    if (new RegExp('\\b' + WAKE + '\\b').test(content)) return true;
    return false;
  }

  // Control commands are @-mention driven (universal — no hardcoded name). We strip the
  // mention; if what remains is a recognized command word we run it, otherwise we return
  // false and it's handled as a normal message. A bare @-mention is a normal message too.
  // Is this author THIS bot's owner? = a full-trust (bypass_moderation) principal in the bot's
  // own trust store (resolved via the core). Fail-secure: any error → not owner.
  async function isOwner(message) {
    try {
      const r = await ctx.core.resolve({
        channel: 'discord',
        sender: { raw_id: String(message.author.id), raw_username: message.author.username },
        context: { scope_id: message.guild ? `guild:${message.guild.id}` : `dm:${message.author.id}` },
      });
      return !!(r && r.bypass_moderation);
    } catch (e) { ctx.log('owner check failed: ' + e.message); return false; }
  }

  async function handleControlCommands(message) {
    // Addressed if @-mentioned directly OR via a role this bot holds (e.g. an "@agents"
    // role, so one ping can command every bot in a group chat at once).
    const botMember = message.guild ? (message.guild.members.me || message.guild.members.cache.get(client.user.id)) : null;
    const roleAddressed = !!botMember && message.mentions.roles.some((r) => botMember.roles.cache.has(r.id));
    if (!message.mentions.has(client.user) && !roleAddressed) return false;
    const cmd = message.content.replace(/<@[!&]?\d+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    const cid = message.channel.id;
    const me = client.user.username;
    // State-changing commands are OWNER-ONLY (status/help stay open to anyone addressed).
    if (OWNER_ONLY_CMDS.has(cmd) && !(await isOwner(message))) {
      await message.channel.send('🔒 Only my owner can run that command.'); return true;
    }
    switch (cmd) {
      case 'silence': case 'be quiet': case 'quiet': case 'shush':
        silenced = true; await message.channel.send(`🤐 Mention-only mode — I'll stay quiet unless @-mentioned. \`@${me} speak\` to restore.`); return true;
      case 'speak': case 'unsilence': case 'wake up': case 'resume':
        silenced = false; await message.channel.send('👋 Autonomous participation restored.'); return true;
      case 'mute': case 'mute here': case 'mute this channel': case 'ignore this channel': case 'disable': case 'disable here':
        channelStates.set(cid, false); saveSettings(); await message.channel.send(`🔇 Disabled in this channel — I'll ignore everything here until \`@${me} unmute\`.`); return true;
      case 'unmute': case 'unmute here': case 'listen here': case 'unmute this channel': case 'enable': case 'enable here':
        channelStates.set(cid, true); saveSettings(); await message.channel.send('🔊 Enabled — listening in this channel again.'); return true;
      case 'engage-all-bots': case 'engage all bots': case 'engage all':
        engageAllBots = true; saveSettings(); await message.channel.send(`🤝 Engaging **all bots** — I'll now hear every bot in my channels, not just my allowlist. \`@${me} disengage-all-bots\` to revert.`); return true;
      case 'disengage-all-bots': case 'disengage all bots': case 'disengage all':
        engageAllBots = false; saveSettings(); await message.channel.send('🙅 Disengaged — back to my configured bot allowlist only.'); return true;
      case 'drone-on': case 'drone on':
        voiceDrone = true; await message.channel.send('🎛 Ambient processing drone **on** for voice replies.'); return true;
      case 'drone-off': case 'drone off':
        voiceDrone = false; await message.channel.send('🎛 Ambient processing drone **off**.'); return true;
      case 'join-voice': case 'join voice': case 'join vc': case 'join the voice':
        await doJoinVoice(message); return true;
      case 'update-asmltr': case 'update asmltr': case 'self-update': case 'update yourself':
        await doUpdateAsmltr(message); return true;
      case 'leave-voice': case 'leave voice': case 'leave vc': case 'leave the voice':
        await doLeaveVoice(message); return true;
      case 'status':
        await message.channel.send(`**Status:** ${silenced ? 'silenced (mention-only)' : 'active (autonomous)'}\n**Bots:** ${engageAllBots ? 'engaging ALL bots' : (allowedBotNames.length ? 'allowlist — ' + allowedBotNames.join(', ') : 'ignoring all bots')}\n**This channel:** ${channelEnabled(cid) ? 'enabled' : 'disabled'} (default: ${channelsDefault ? 'enabled' : 'disabled'})`); return true;
      case 'help': case 'commands':
        await message.channel.send(`**Commands** — \`@${me} <command>\`:\n\`silence\` / \`speak\` · \`disable\` / \`enable\` (aka \`mute\`/\`unmute\`, this channel) · \`engage-all-bots\` / \`disengage-all-bots\` · \`join-voice\` / \`leave-voice\` · \`drone-on\` / \`drone-off\` · \`update-asmltr\` · \`status\``); return true;
      default:
        return false; // not a recognized command → treat as a normal message
    }
  }

  // --- Discord context → system_prompt_extra (server-aware authz + context) ---
  function buildSystemExtra(message, context, forced) {
    const mentioned = message.mentions.has(client.user);
    const mode = forced ? 'You were directly @-mentioned (silence mode is on, so only mentions reach you).'
      : mentioned ? 'You were directly @-mentioned.'
      : 'You were NOT @-mentioned — this message was surfaced as *possibly* relevant. Decide whether it is actually for you (see MULTI-AGENT below) before replying.';
    const primary = context.primary.map(m => `[${m.author}]: ${m.content}`).join('\n');
    const cross = context.crossContext.length ? `\n\nCROSS-CONTEXT (other servers/channels, reference only):\n${context.crossContext.map(m => `- [${m.serverName}/#${m.channelName}] ${m.author}: ${m.content.substring(0, 100)}...`).join('\n')}` : '';
    // NOTE: authorization/trust is now the core's trust framework (data-driven,
    // scoped per server) — NOT hardcoded here. This preamble is Discord CONTEXT only.
    const iAmMentioned = message.mentions.has(client.user);
    const others = [...message.mentions.users.values()].filter((u) => u.id !== client.user.id).map((u) => '@' + u.username);
    const mentionLine = iAmMentioned
      ? `It **@-mentions YOU (${NAME})**${others.length ? `, along with ${others.join(', ')}` : ''} — so it IS addressed to you; answer it.`
      : (others.length ? `It @-mentions ${others.join(', ')} — NOT you.` : 'It @-mentions no one specifically.');
    return `DISCORD CONTEXT
- You are **${NAME}**. In this message text, "@${NAME}" (and the id <@${client.user.id}>) refer to YOU, not any other bot.
- Server: ${context.location.serverName} · Channel: #${context.location.channelName} (id ${message.channel.id}) · Participants: ${context.location.participants.join(', ')}
- ${mode}
- THIS message is from **${message.author.username}**. ${mentionLine} Address your reply to ${message.author.username}. Do NOT greet or address anyone else unless THIS message is literally from them — a mention of someone is not that person speaking.

MULTI-AGENT CHANNEL — CRITICAL:
This channel may contain OTHER AI assistants and bots besides you. A message is FOR YOU only if it @-mentions you, addresses you by name ("${NAME}"), directly continues/answers something YOU said, or is an open question to the room that you are clearly the right one to answer. A message is NOT for you if it addresses a DIFFERENT agent or bot by name (e.g. someone saying "moneo, ..." or testing another bot), is a reply aimed at another agent, or simply isn't directed at you. **If the message is not for you, you MUST NOT reply — output ONLY the token ${NO_REPLY} and nothing else.** When unsure in a busy multi-agent channel, choose ${NO_REPLY}.

Those other agents are CONVERSATIONAL PEERS in this channel — not tools, systems, or data sources. If someone asks you to ask / relay / check something WITH another agent (e.g. "ask Thor what time it is"), do NOT try to answer on their behalf and do NOT look them up with your tools or search. Just post a normal message addressing that agent by name (e.g. "Thor, what time is it for [REDACTED]?") — they read this channel and will answer for themselves. Talking TO another agent by name is a valid reply here.

IMMEDIATE CONVERSATION (last 10 in this channel):
${primary}${cross}

RESPONSE RULES:
1. Your text output IS the Discord message — do NOT call any external send/notify tool; just output the text.
2. Output ONLY your conversational response — no summary/narration afterward.
3. Keep it conversational and substantive (under ~1500 chars ideally).
4. If this message is not for you (see MULTI-AGENT CHANNEL), output ONLY the token ${NO_REPLY} and nothing else — do not explain, do not greet, just the token.`;
  }

  function formatCodeBlocks(text) {
    return text.replace(/```(?:\w+)?\n([\s\S]*?)```/g, (m, code) => '\n' + code.split('\n').map(l => '    ' + l).join('\n') + '\n');
  }
  function splitResponse(text, max = 1900) {
    const chunks = []; let cur = '';
    for (const para of text.split('\n\n')) {
      if ((cur + para).length > max) { if (cur) chunks.push(cur.trim()); cur = para; }
      else cur += (cur ? '\n\n' : '') + para;
    }
    if (cur) chunks.push(cur.trim());
    return chunks;
  }

  async function handleMessage(message, forced) {
    const cid = message.channel.id;
    if (processing.get(cid)) return; // already handling a message in this channel — stay silent (no channel spam)
    processing.set(cid, true);
    // Discord's typing indicator auto-expires after ~10s. Re-trigger it every
    // 8s so the "…is typing" shows for the ENTIRE (possibly multi-minute)
    // processing time, not just the first few seconds. Cleared in finally.
    let typingInterval = null;
    try {
      await message.channel.sendTyping();
      typingInterval = setInterval(() => { message.channel.sendTyping().catch(() => {}); }, 8000);
      const context = getRelevantContext(message);
      const sid = message.guild?.id;
      // per-CHANNEL session (was per-guild): prevents cross-channel/cross-speaker
      // context bleed — e.g. resuming a Moneo-heavy guild session in a different
      // channel and continuing to address Moneo.
      const conversationKey = sid ? `discord:${ctx.instanceId}:channel:${cid}` : `discord:${ctx.instanceId}:dm:${message.author.id}`;
      let text = message.cleanContent || message.content; // resolve <@id>/<@&role> tags to readable @names so the model knows who's who
      // Vision: download supported image attachments and pass them as real image
      // content (base64) so the assistant actually SEES them — not a CDN URL she can't open.
      // Non-image / oversized / unsupported attachments stay as a text URL mention.
      const SUPPORTED_IMG = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      const MAX_IMG_BYTES = 5 * 1024 * 1024;
      const imageAttachments = [];
      if (message.attachments.size > 0) {
        const otherAttachments = [];
        for (const a of message.attachments.values()) {
          const mt = (a.contentType || '').split(';')[0].trim();
          if (SUPPORTED_IMG.includes(mt) && imageAttachments.length < 5 && (a.size || 0) <= MAX_IMG_BYTES) {
            try {
              const buf = Buffer.from(await (await fetch(a.url)).arrayBuffer());
              imageAttachments.push({ type: 'image', media_type: mt, data: buf.toString('base64'), name: a.name });
            } catch (e) { ctx.log(`[img] download failed ${a.name}: ${e.message}`); otherAttachments.push(a); }
          } else {
            otherAttachments.push(a);
          }
        }
        if (otherAttachments.length) text += '\n\nATTACHMENTS:\n' + otherAttachments.map(a => `- ${a.name} (${a.contentType}): ${a.url}`).join('\n');
      }
      // server + channel names ride in channel_context → the core records them on the inbound
      // event (and the collector stores them on the session) so the dashboard shows where a
      // conversation is happening. (No separate inbound emit here — the core records inbound.)
      const actions = await ctx.core.handle({
        channel: 'discord',
        conversation_key: conversationKey,
        message_id: String(message.id),
        sender: { raw_id: String(message.author.id), raw_username: message.author.username },
        content: { text, attachments: imageAttachments },
        delivery: 'sync',
        capabilities: meta.capabilities,
        public: message.channel.type !== 1, // guild channel = public; DM (type 1) = private
        channel_context: { channelId: cid, server: context.location.serverName, channel: context.location.channelName },
        context: { scope_id: sid ? `guild:${sid}` : `dm:${message.author.id}`, scope_name: context.location.serverName },
        system_prompt_extra: buildSystemExtra(message, context, forced),
      });

      const reply = actions.find(a => a.type === 'reply');
      const replyText = reply ? reply.text.trim() : '';
      // Self-gated suppression: the model decided this message wasn't for it (multi-agent
      // channel), or there's nothing to say. Drop it — don't post to the channel.
      const gated = replyText.toUpperCase().includes(NO_REPLY.toUpperCase())
        || replyText.toLowerCase() === 'no response';
      if (!replyText || gated) { ctx.log(`suppressed reply (not addressed to ${NAME})`); return; }
      // Dedup: never re-post a message verbatim-identical to one of the last few we sent here.
      // Long resumed sessions (esp. AI-to-AI loops) can occasionally replay an earlier reply.
      const recents = recentReplies.get(cid) || [];
      if (recents.includes(replyText)) { ctx.log('suppressed duplicate reply (verbatim repeat of a recent message)'); return; }
      recents.push(replyText); if (recents.length > 6) recents.shift(); recentReplies.set(cid, recents);
      for (const chunk of splitResponse(formatCodeBlocks(replyText))) await message.channel.send(chunk);
      saveMemory(message, NAME, replyText);
      lastResponseTime = Date.now();
      responseCount.set(cid, (responseCount.get(cid) || 0) + 1);
      setTimeout(() => responseCount.set(cid, Math.max(0, (responseCount.get(cid) || 0) - 1)), 3600000);
    } catch (e) {
      ctx.log('handle error: ' + e.message);
      await message.channel.send('⚠️ I hit an error processing that. Recalibrating...').catch(() => {});
    } finally {
      if (typingInterval) clearInterval(typingInterval);
      processing.delete(cid);
    }
  }

  // --- Discord client ---
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildVoiceStates],
    partials: [Partials.Channel, Partials.Message],
  });
  client.once('ready', () => { ctx.log(`online as ${client.user.tag}`); if (cfg.presence_text) client.user.setPresence({ activities: [{ name: cfg.presence_text }], status: 'online' }); });
  client.on('error', (e) => ctx.log('client error: ' + e.message));
  // --- voice transcription helper: per-utterance WAV → OpenAI STT → text --------
  const voiceText = new Map(); // guildId -> text channel to post the live transcript
  async function sttTranscribe(wav) {
    const key = await ctx.secrets.get('openai_api_key');
    const fd = new FormData();
    fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'utt.wav');
    fd.append('model', 'gpt-4o-transcribe');
    const lang = cfg.stt_language === undefined ? 'en' : cfg.stt_language;
    if (lang) fd.append('language', lang); // constrain output → stops foreign-character hallucinations
    fd.append('prompt', `Casual voice-chat speech; the speaker may address an assistant named ${NAME}.`); // bias toward the wake word
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd });
    if (!r.ok) throw new Error(`stt ${r.status}`);
    const j = await r.json();
    return j.text || '';
  }

  // --- gatekeeper: does this spoken utterance ADDRESS the assistant? (heuristic v1) --------
  // Cheap/free/instant — no per-utterance model call. Upgrade path: a Haiku confirm
  // for ambiguous "the assistant" mentions. Conservative on purpose to avoid interrupting.
  function addressesEve(text) {
    const t = text.trim().toLowerCase();
    return new RegExp(`^(hey |hi |ok |okay |yo |so |well |um+ |uh+ |,|\\s)*${WAKE}\\b`).test(t) // LEADS with the name ("<name>, do X")
        || new RegExp(`\\b(hey|ok|okay|hi|yo) ${WAKE}\\b`).test(t)                              // "hey <name>" anywhere
        || new RegExp(`\\b${WAKE}\\s*[,?!.]`).test(t)                                           // "<name>," / "<name>?" / "<name>!"
        || new RegExp(`\\b${WAKE}\\b[\\s.?!,]*$`).test(t);                                      // TRAILS with the name ("do X, <name>")
  }

  const VOICE_GUIDANCE = [
    'You are in a LIVE Discord voice meeting and your reply will be spoken aloud via text-to-speech.',
    'Keep it short and natural — 1 to 3 sentences. No markdown, no bullet lists, no code blocks, no emoji, no URLs read out.',
    'You may use tools if truly needed, but keep the SPOKEN answer brief and conversational.',
  ].join(' ');

  async function elevenLabsTTS(text) {
    try {
      const key = await ctx.secrets.get(cfg.elevenlabs_key_name || 'elevenlabs_api_key');
      const voiceId = cfg.voice_id || '21m00Tcm4TlvDq8ikWAM'; // TODO: drop in the assistant's real voice
      const model = cfg.tts_model || 'eleven_turbo_v2_5';
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: model }),
      });
      if (!r.ok) { ctx.log(`[voice] tts ${r.status}`); return null; }
      return Buffer.from(await r.arrayBuffer());
    } catch (e) { ctx.log(`[voice] tts failed: ${e.message}`); return null; }
  }

  const voiceBusy = new Set();   // guildIds mid-reply (one spoken reply at a time)
  const voiceActive = new Map(); // guildId -> expiry ts of the "answering mode" follow-up window
  // 0 (default) = STRICT: respond ONLY when directly addressed by name, then go passive. A positive
  // value opens a "keep answering follow-ups without the wake word" window for that many ms.
  const VOICE_WINDOW_MS = Number.isFinite(Number(cfg.voice_followup_ms)) ? Number(cfg.voice_followup_ms) : 0;
  let voiceDrone = cfg.voice_drone !== false; // ambient "working" drone during a spoken reply (toggleable)

  // Reflect what the bot is doing in its live Discord presence (voice tasks). null → back to idle/config.
  const idlePresence = cfg.presence_text || null;
  function setVoiceStatus(text) {
    try {
      if (text) client.user.setPresence({ status: 'online', activities: [{ name: text, type: ActivityType.Custom, state: text }] });
      else if (idlePresence) client.user.setPresence({ status: 'online', activities: [{ name: idlePresence, type: ActivityType.Custom, state: idlePresence }] });
      else client.user.setPresence({ status: 'online', activities: [] });
    } catch (_) {}
  }
  const LEAVE_RE = /\b(leave (the )?(voice|call|channel)|disconnect|drop (from )?(the )?(voice|call))\b/;
  const DISMISS_RE = /\b(that'?s (enough|all|it)( for now)?|we'?re (good|done|all set)|stop (answering|talking|responding|for now)|(just|go back to) (listen|transcrib)|you can (stop|relax)|stand down|dismiss(ed)?)\b/;

  // Called for EVERY transcribed utterance. Posts the live transcript, then decides if it's for
  // the assistant — addressed by name OR we're inside an active follow-up window (so follow-ups
  // need no wake word). A dismissal phrase exits answering mode back to transcription-only.
  async function handleVoiceUtterance(guildId, name, text) {
    const ch = voiceText.get(guildId);
    if (ch) ch.send(`🗣️ **${name}:** ${text}`).catch(() => {});
    let voice; try { voice = require('./voice'); } catch (_) { return; }
    const lc = text.toLowerCase();
    const active = (voiceActive.get(guildId) || 0) > Date.now();

    // spoken "leave voice" → actually disconnect from the voice channel
    if ((addressesEve(text) || active) && LEAVE_RE.test(lc)) {
      voiceActive.delete(guildId); voiceText.delete(guildId); voice.leave(guildId); setVoiceStatus(null);
      if (ch) ch.send('👋 Left the voice channel.').catch(() => {});
      return;
    }
    // spoken dismissal → exit answering mode but STAY listening/transcribing
    if (active && DISMISS_RE.test(lc)) {
      voiceActive.delete(guildId);
      try { await voice.playChime(guildId); } catch (_) {}
      if (ch) ch.send('🔉 Back to just listening — say my name when you want me again.').catch(() => {});
      return;
    }

    // For me? addressed by name, or inside an active follow-up window. Otherwise just transcribe.
    if (!addressesEve(text) && !active) return;

    if (voiceBusy.has(guildId)) return; // don't stack replies
    voiceBusy.add(guildId);
    try {
      if (!active) { await voice.playChime(guildId); await new Promise((r) => setTimeout(r, 600)); } // "I heard you" — only when ENTERING a conversation
      setVoiceStatus(`💭 ${String(text).slice(0, 40)}`);
      if (voiceDrone) voice.startDrone(guildId); // soft "working on it" ambience (toggleable)

      // STREAM the reply: TTS + speak sentence-by-sentence as the answer generates, so long
      // answers start playing right away instead of after the whole thing is written. TTS runs
      // in parallel; playback is chained so sentences are spoken in order.
      let buf = '', full = '', firstAudio = false, chain = Promise.resolve();
      const speakSentence = (s) => {
        const t = s.trim(); if (!t) return;
        const ttsP = elevenLabsTTS(t);
        chain = chain.then(async () => {
          const mp3 = await ttsP;
          if (!mp3) return;
          if (!firstAudio) { firstAudio = true; voice.stopDrone(guildId); setVoiceStatus('🔊 speaking'); }
          await voice.speak(guildId, mp3);
        }).catch((e) => ctx.log(`[voice] speak failed: ${e.message}`));
      };
      const flush = (finalize) => {
        const re = /[^.!?\n]*[.!?\n]+/g; let m, last = 0;
        while ((m = re.exec(buf))) { speakSentence(m[0]); last = re.lastIndex; }
        buf = buf.slice(last);
        if (finalize && buf.trim()) { speakSentence(buf); buf = ''; }
      };
      await ctx.core.handleStream({
        channel: 'discord',
        conversation_key: `discord-voice:${ctx.instanceId}:guild:${guildId}`,
        message_id: `voice-${Date.now()}`,
        sender: { raw_id: name, raw_username: name },
        content: { text },
        delivery: 'sync',
        capabilities: { max_message_chars: 700, supports_markdown: false },
        public: true, // spoken into a room → redaction applies (never speak secrets aloud)
        system_prompt_extra: VOICE_GUIDANCE,
        channel_context: { voice: true, speaker: name },
      }, (delta) => { buf += delta; full += delta; flush(false); });
      flush(true);
      await chain; // wait until every sentence has finished speaking
      voice.stopDrone(guildId);
      if (full.trim() && ch) ch.send(`🔊 **${NAME}:** ${full.trim().slice(0, 1800)}`).catch(() => {});
      if (VOICE_WINDOW_MS > 0) voiceActive.set(guildId, Date.now() + VOICE_WINDOW_MS); // open the follow-up window (strict mode: never)
    } catch (e) { voice.stopDrone(guildId); ctx.log(`[voice] reply failed: ${e.message}`); if (ch) ch.send(`⚠️ voice reply failed: ${e.message}`).catch(() => {}); }
    finally { voiceBusy.delete(guildId); setVoiceStatus(null); } // back to listening/idle
  }

  // Voice commands: "the assistant, join" (joins the author's voice channel + chimes + listens) / "the assistant, leave".
  // All voice work is sandboxed so it can never crash the text presence.
  // Join the requester's voice channel + start listening. Triggered by the `join-voice`
  // command (@mention driven, in handleControlCommands).
  async function doJoinVoice(message) {
    if (!message.guild) return;
    let voice;
    try { voice = require('./voice'); } catch (e) { ctx.log(`voice module load failed: ${e.message}`); message.channel.send('⚠️ Voice module unavailable.').catch(() => {}); return; }
    const vc = message.member?.voice?.channel;
    if (!vc) { message.channel.send(`🎙️ Hop into a voice channel first, then \`@${client.user.username} join-voice\`.`).catch(() => {}); return; }
    try {
      await voice.joinChannel(vc);
      await voice.playChime(message.guild.id);
      voiceText.set(message.guild.id, message.channel);
      voice.startListening(message.guild.id, client, {
        transcribe: sttTranscribe,
        onUtterance: (name, text) => handleVoiceUtterance(message.guild.id, name, text),
        log: (m) => ctx.log(`[voice] ${m}`),
      });
      setVoiceStatus(`🎧 listening · ${vc.name}`);
      message.channel.send(`🎙️ Joined **${vc.name}** — I'm listening. I transcribe everyone as \`🗣️ name: …\`. Say **"${NAME}, …"** out loud to ask something — I'll chime, play a soft "working" tone, and answer by voice. After that, **follow-ups need no name** for a bit; say **"that's enough, ${NAME}"** to go back to just listening, or \`@${client.user.username} leave-voice\` to disconnect.`).catch(() => {});
    } catch (e) { ctx.log(`voice join failed: ${e.stack || e.message}`); message.channel.send(`⚠️ Couldn't join voice: ${e.message}`).catch(() => {}); }
  }

  async function doLeaveVoice(message) {
    if (!message.guild) return;
    let voice; try { voice = require('./voice'); } catch (_) { return; }
    voiceText.delete(message.guild.id);
    const left = voice.leave(message.guild.id);
    setVoiceStatus(null); // back to idle/config presence
    message.channel.send(left ? '👋 Left the voice channel.' : "I'm not in a voice channel.").catch(() => {});
  }

  // Queue a channel message to be delivered AFTER the next restart (drained by the manager
  // once this connector reconnects). dataDir === the manager's data dir, so we write its queue.
  function queueAnnouncement(channelId, text) {
    const f = path.join(dataDir, 'announcements.json');
    let q = []; try { q = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {}
    if (!Array.isArray(q)) q = [];
    q.push({ channel: 'discord', instance_id: ctx.instanceId, target: channelId, kind: 'text', text });
    try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(f, JSON.stringify(q)); } catch (e) { ctx.log('announce queue failed: ' + e.message); }
  }

  // `update-asmltr` command: pull the latest code, reinstall deps, and restart — DETACHED so the
  // restart survives this very connector being cycled — then confirm in-channel after it's back up.
  async function doUpdateAsmltr(message) {
    const { exec, spawn, execSync } = require('child_process');
    const repo = path.join(__dirname, '..', '..', '..'); // connectors/types/discord → repo root
    await message.channel.send('🔄 Updating asmltr — pulling latest + reinstalling. I\'ll confirm here once the restart completes (~15s).').catch(() => {});
    exec('git fetch origin && git reset --hard origin/main', { cwd: repo, timeout: 120000 }, (e1, o1, s1) => {
      if (e1) { message.channel.send(`⚠️ Update failed (git): ${String(s1 || e1.message).slice(0, 400)}`).catch(() => {}); return; }
      exec('for d in core connectors insights/collector cli; do (cd "$d" && npm install) || exit 1; done', { cwd: repo, timeout: 600000, shell: '/bin/bash' }, (e2, o2, s2) => {
        if (e2) { message.channel.send(`⚠️ Update failed (npm install): ${String(s2 || e2.message).slice(0, 400)}`).catch(() => {}); return; }
        let commit = '';
        try { commit = execSync('git rev-parse --short HEAD', { cwd: repo }).toString().trim(); } catch (_) {}
        queueAnnouncement(message.channel.id, `✅ asmltr updated${commit ? ` to \`${commit}\`` : ''} and restarted — all systems back online.`);
        const script = 'sleep 5; pkill -f "connectors/runtime/run-instance.js"; sleep 2; pm2 restart asmltr-core asmltr-insights-collector asmltr-connector-manager';
        try { spawn('setsid', ['bash', '-c', script], { detached: true, stdio: 'ignore', cwd: repo }).unref(); }
        catch (e3) { message.channel.send(`⚠️ Update installed but restart-launch failed: ${e3.message}`).catch(() => {}); }
      });
    });
  }

  client.on('messageCreate', async (message) => {
    if (message.author.id === client.user.id) return;
    // Ignore voice transcript / spoken-reply mirror lines (🗣️ / 🔊) that ANY agent posts for
    // its own voice session — they're artifacts, never conversation for another agent to answer.
    if (/^\s*(?:🗣️|🔊)/u.test(message.content || '')) return;
    if (message.author.bot && !isAllowedBot(message.author.username)) return;
    saveMemory(message, message.author.username, message.content);
    if (await handleControlCommands(message)) return;
    if (!channelEnabled(message.channel.id)) return; // channel disabled — no relay to core, no usage (mention-commands above still work)
    // While in an active voice session for this guild, answer by VOICE only — don't ALSO run
    // autonomous text participation (that caused a doubled reply: spoken + a text-channel reply).
    // Direct @mentions still get a text reply; the voice path handles spoken utterances.
    if (message.guild && voiceText.has(message.guild.id) && !message.mentions.has(client.user)) return;
    // Drop messages directed at ANOTHER specific agent — either an @-mention of another user/bot,
    // OR a message that LEADS with another agent's name ("Moneo, …" — a plain name Discord does
    // NOT turn into a real @-mention). Passive mid-sentence name-drops + anything addressing US
    // still flow through to shouldRespondTo, so autonomous participation is preserved.
    if (ignoreOtherMentions && message.guild) {
      const c = (message.content || '').toLowerCase();
      const addressesMe = message.mentions.has(client.user) || new RegExp(`^\\s*@?${WAKE}\\b`).test(c);
      const escaped = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const leadsOtherAgent = allowedBotNames.some((n) => new RegExp(`^\\s*@?${escaped(n)}\\b`).test(c));
      const directedElsewhere = (message.mentions.users.size > 0 && !message.mentions.has(client.user)) || leadsOtherAgent;
      if (directedElsewhere && !addressesMe) return;
    }
    if (silenced) { if (message.mentions.has(client.user)) await handleMessage(message, true); return; }
    if (shouldRespondTo(message)) await handleMessage(message, false);
  });

  // --- /send-message endpoint (message-discord depends on this) ---
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.get('/health', (req, res) => res.json({ status: 'ok', type: 'discord', instance: ctx.instanceId, uptime: process.uptime() }));
  app.post('/send-message', async (req, res) => {
    try {
      const { channelId, message } = req.body;
      if (!channelId || !message) return res.status(400).json({ success: false, error: 'channelId and message required' });
      const channel = await client.channels.fetch(channelId, { force: true });
      if (!channel || !channel.isTextBased()) return res.status(404).json({ success: false, error: 'channel not found / not text' });
      await channel.send(message);
      res.json({ success: true, channelId });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });
  // Unified outbound endpoint (manager /send router → here). Resolves aliases.
  app.post('/out', async (req, res) => {
    try {
      const { kind = 'text', target: tg, text, path: filePath, caption } = req.body || {};
      const channel = await client.channels.fetch(resolveChannel(tg), { force: true });
      if (!channel || !channel.isTextBased()) return res.status(404).json({ ok: false, error: 'channel not found / not text' });
      // any file kind (photo/file/attachment/document/image) → send as a Discord attachment
      const isFile = ['photo', 'file', 'attachment', 'document', 'image'].includes(kind);
      if (isFile && !filePath) return res.status(400).json({ ok: false, error: 'file kind requires a `path`' });
      const m = isFile ? await channel.send({ content: caption || text || '', files: [filePath] }) : await channel.send(text);
      res.json({ ok: true, messageId: m.id });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  // --- channel enable/disable control (TUI/GUI drive this) -------------------------------
  // GET → every text channel the bot can see, with its effective enabled state.
  app.get('/channels', (req, res) => {
    try {
      const rows = [];
      for (const g of client.guilds.cache.values()) {
        for (const ch of g.channels.cache.values()) {
          if (![0, 5].includes(ch.type)) continue; // GuildText(0) + Announcement(5) only
          rows.push({ guild_id: g.id, guild: g.name, channel_id: ch.id, name: ch.name, enabled: channelEnabled(ch.id), explicit: channelStates.has(ch.id) });
        }
      }
      rows.sort((a, b) => (a.guild + '#' + a.name).localeCompare(b.guild + '#' + b.name));
      res.json({ ok: true, default_enabled: channelsDefault, channels: rows });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  // POST { channel_id, enabled } → set an override; { channel_id, clear:true } → drop to default;
  // { default_enabled } → flip the blocklist/allowlist default. Takes effect immediately (no restart).
  app.post('/channels', (req, res) => {
    try {
      const { channel_id, enabled, clear, default_enabled } = req.body || {};
      if (typeof default_enabled === 'boolean') channelsDefault = default_enabled;
      if (channel_id != null) {
        if (clear) channelStates.delete(String(channel_id));
        else channelStates.set(String(channel_id), !!enabled);
      }
      saveSettings();
      res.json({ ok: true, default_enabled: channelsDefault, channel_id: channel_id != null ? String(channel_id) : null, enabled: channel_id != null ? channelEnabled(channel_id) : null });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  const httpServer = app.listen(cfg.http_port || 3016, '127.0.0.1', () => ctx.log(`send-message API on 127.0.0.1:${cfg.http_port || 3016}`));

  await client.login(token);

  return {
    async stop() { try { await client.destroy(); } catch (_) {} try { httpServer.close(); } catch (_) {} persistMemory(); },
    health() { return { online: !!client.user, silenced }; },
  };
}

module.exports = { meta, start };
