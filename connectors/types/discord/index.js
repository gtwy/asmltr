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
const { Client, GatewayIntentBits, Partials } = require('discord.js');

// Assistant identity — the display name AND the spoken wake word for voice.
const NAME = process.env.ASSISTANT_NAME || 'Assistant';
const WAKE = NAME.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // regex-escaped
// Self-gating sentinel: in a multi-agent channel the model emits ONLY this token when a
// message isn't meant for it, and the connector drops the reply instead of posting it.
const NO_REPLY = '[[NO_REPLY]]';

const meta = {
  type: 'discord',
  displayName: 'Discord',
  supportsMultiple: true,
  capabilities: { max_message_chars: 2000, supports_markdown: true, supports_code_blocks: false },
  credentialKeys: ['bot_token_bws_key'],
  // How the Access page presents identifiers for this surface (trust framework).
  identifierFormats: [{ surface: 'discord', label: 'Discord User ID', placeholder: '000000000000000000', pattern: '^\\d+$' }],
  outbound: { kinds: ['text', 'photo'], target: { required: true, label: 'Channel id or alias (e.g. TD-TSD-main)' } },
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
      ignore_other_mentions: { type: 'boolean', title: 'Ignore messages @-directed at other specific users/bots (keeps passive name-drops)', default: true },
    },
  },
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
  // persisted per-instance settings: per-channel mutes + engage-all-bots toggle
  const settingsFile = path.join(dataDir, `discord-${ctx.instanceId}-settings.json`);
  const mutedChannels = new Set();
  let engageAllBots = false;
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    (s.mutedChannels || []).forEach((c) => mutedChannels.add(c));
    engageAllBots = !!s.engageAllBots;
  } catch (_) {}
  function saveSettings() {
    try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify({ mutedChannels: [...mutedChannels], engageAllBots })); }
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
  async function handleControlCommands(message) {
    // Addressed if @-mentioned directly OR via a role this bot holds (e.g. an "@agents"
    // role, so one ping can command every bot in a group chat at once).
    const botMember = message.guild ? (message.guild.members.me || message.guild.members.cache.get(client.user.id)) : null;
    const roleAddressed = !!botMember && message.mentions.roles.some((r) => botMember.roles.cache.has(r.id));
    if (!message.mentions.has(client.user) && !roleAddressed) return false;
    const cmd = message.content.replace(/<@[!&]?\d+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    const cid = message.channel.id;
    const me = client.user.username;
    switch (cmd) {
      case 'silence': case 'be quiet': case 'quiet': case 'shush':
        silenced = true; await message.channel.send(`🤐 Mention-only mode — I'll stay quiet unless @-mentioned. \`@${me} speak\` to restore.`); return true;
      case 'speak': case 'unsilence': case 'wake up': case 'resume':
        silenced = false; await message.channel.send('👋 Autonomous participation restored.'); return true;
      case 'mute': case 'mute here': case 'mute this channel': case 'ignore this channel':
        mutedChannels.add(cid); saveSettings(); await message.channel.send(`🔇 Muted in this channel — I'll ignore everything here until \`@${me} unmute\`.`); return true;
      case 'unmute': case 'unmute here': case 'listen here': case 'unmute this channel':
        mutedChannels.delete(cid); saveSettings(); await message.channel.send('🔊 Unmuted — listening in this channel again.'); return true;
      case 'engage-all-bots': case 'engage all bots': case 'engage all':
        engageAllBots = true; saveSettings(); await message.channel.send(`🤝 Engaging **all bots** — I'll now hear every bot in my channels, not just my allowlist. \`@${me} disengage-all-bots\` to revert.`); return true;
      case 'disengage-all-bots': case 'disengage all bots': case 'disengage all':
        engageAllBots = false; saveSettings(); await message.channel.send('🙅 Disengaged — back to my configured bot allowlist only.'); return true;
      case 'status':
        await message.channel.send(`**Status:** ${silenced ? 'silenced (mention-only)' : 'active (autonomous)'}\n**Bots:** ${engageAllBots ? 'engaging ALL bots' : (allowedBotNames.length ? 'allowlist — ' + allowedBotNames.join(', ') : 'ignoring all bots')}\n**Muted here:** ${mutedChannels.has(cid) ? 'yes' : 'no'}`); return true;
      case 'help': case 'commands':
        await message.channel.send(`**Commands** — \`@${me} <command>\`:\n\`silence\` / \`speak\` · \`mute\` / \`unmute\` (this channel) · \`engage-all-bots\` / \`disengage-all-bots\` · \`status\``); return true;
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
    const mentionedUsers = [...message.mentions.users.values()].map((u) => u.username).filter((n) => n !== client.user.username).join(', ');
    return `DISCORD CONTEXT
- You are **${NAME}**. Your Discord user id is <@${client.user.id}> — that tag means YOU (not any other bot).
- Server: ${context.location.serverName} · Channel: #${context.location.channelName} · Participants: ${context.location.participants.join(', ')}
- ${mode}
- THIS message is from **${message.author.username}**${mentionedUsers ? ` (it mentions: ${mentionedUsers})` : ''}. Address your reply to ${message.author.username}. Do NOT greet or address anyone else unless THIS message is literally from them — a mention of someone is not that person speaking.

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
    try {
      await message.channel.sendTyping();
      const context = getRelevantContext(message);
      const sid = message.guild?.id;
      // per-CHANNEL session (was per-guild): prevents cross-channel/cross-speaker
      // context bleed — e.g. resuming a Moneo-heavy guild session in a different
      // channel and continuing to address Moneo.
      const conversationKey = sid ? `discord:${ctx.instanceId}:channel:${cid}` : `discord:${ctx.instanceId}:dm:${message.author.id}`;
      let text = message.content;
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
      ctx.emit({ event_type: 'inbound', session_id: conversationKey, identity: message.author.username, payload: { server: context.location.serverName, channel: context.location.channelName, images: imageAttachments.length } });

      const actions = await ctx.core.handle({
        channel: 'discord',
        conversation_key: conversationKey,
        message_id: String(message.id),
        sender: { raw_id: String(message.author.id), raw_username: message.author.username },
        content: { text, attachments: imageAttachments },
        delivery: 'sync',
        capabilities: meta.capabilities,
        public: message.channel.type !== 1, // guild channel = public; DM (type 1) = private
        channel_context: { channelId: cid },
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
      for (const chunk of splitResponse(formatCodeBlocks(replyText))) await message.channel.send(chunk);
      saveMemory(message, NAME, replyText);
      lastResponseTime = Date.now();
      responseCount.set(cid, (responseCount.get(cid) || 0) + 1);
      setTimeout(() => responseCount.set(cid, Math.max(0, (responseCount.get(cid) || 0) - 1)), 3600000);
    } catch (e) {
      ctx.log('handle error: ' + e.message);
      await message.channel.send('⚠️ I hit an error processing that. Recalibrating...').catch(() => {});
    } finally {
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
    return new RegExp(`^(hey |hi |ok |okay |yo |so |well |um+ |uh+ |,|\\s)*${WAKE}\\b`).test(t) // opens by addressing the assistant
        || new RegExp(`\\b(hey|ok|okay|hi|yo) ${WAKE}\\b`).test(t)                              // "hey <name>" anywhere
        || new RegExp(`\\b${WAKE}\\s*[,?]`).test(t);                                            // "<name>," / "<name>?"
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

  const voiceBusy = new Set(); // guildIds mid-reply (one spoken reply at a time)
  // Called for EVERY transcribed utterance: post the live transcript, then — if the assistant is
  // addressed — chime, run a full the assistant turn, and speak the reply back into the channel.
  async function handleVoiceUtterance(guildId, name, text) {
    const ch = voiceText.get(guildId);
    if (ch) ch.send(`🗣️ **${name}:** ${text}`).catch(() => {});
    if (!addressesEve(text)) return;
    let voice; try { voice = require('./voice'); } catch (_) { return; }
    if (/\b(leave|disconnect|go away|dismissed|that'?s all)\b/.test(text.toLowerCase())) {
      voiceText.delete(guildId); voice.leave(guildId);
      if (ch) ch.send('👋 Heard "leave" — disconnecting from voice.').catch(() => {});
      return;
    }
    if (voiceBusy.has(guildId)) return; // don't stack replies
    voiceBusy.add(guildId);
    try {
      await voice.playChime(guildId); // "I heard you" ack
      const actions = await ctx.core.handle({
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
      });
      const reply = (actions || []).find((a) => a.type === 'reply');
      const say = reply && reply.text ? reply.text.trim() : '';
      if (say) {
        if (ch) ch.send(`🔊 **${NAME}:** ${say}`).catch(() => {});
        const mp3 = await elevenLabsTTS(say);
        if (mp3) await voice.speak(guildId, mp3);
      }
    } catch (e) { ctx.log(`[voice] reply failed: ${e.message}`); if (ch) ch.send(`⚠️ voice reply failed: ${e.message}`).catch(() => {}); }
    finally { voiceBusy.delete(guildId); }
  }

  // Voice commands: "the assistant, join" (joins the author's voice channel + chimes + listens) / "the assistant, leave".
  // All voice work is sandboxed so it can never crash the text presence.
  async function handleVoiceCommands(message) {
    if (!message.guild) return false;
    const c = (message.content || '').toLowerCase().trim();
    const joinCmd = new RegExp(`^${WAKE}[,:]?\\s+(join|come)\\b`).test(c) || new RegExp(`\\b${WAKE}\\b[^.!?]*\\bjoin\\b[^.!?]*\\b(voice|call|channel|me|us|here)\\b`).test(c);
    const leaveCmd = new RegExp(`^${WAKE}[,:]?\\s+leave\\b`).test(c) || new RegExp(`\\b${WAKE}\\b[^.!?]*\\bleave\\b[^.!?]*\\b(voice|call|channel)\\b`).test(c);
    if (!joinCmd && !leaveCmd) return false;
    let voice;
    try { voice = require('./voice'); } catch (e) { ctx.log(`voice module load failed: ${e.message}`); return false; }
    if (joinCmd) {
      const vc = message.member?.voice?.channel;
      if (!vc) { message.channel.send(`🎙️ Hop into a voice channel first, then say **"${NAME}, join"**.`).catch(() => {}); return true; }
      try {
        await voice.joinChannel(vc);
        await voice.playChime(message.guild.id);
        voiceText.set(message.guild.id, message.channel);
        voice.startListening(message.guild.id, client, {
          transcribe: sttTranscribe,
          onUtterance: (name, text) => handleVoiceUtterance(message.guild.id, name, text),
          log: (m) => ctx.log(`[voice] ${m}`),
        });
        message.channel.send(`🎙️ Joined **${vc.name}** — I'm listening. I'll transcribe everyone here as \`🗣️ name: …\`, and if you say **"${NAME}, …"** I'll chime and answer out loud. Say **"${NAME}, leave"** to disconnect.`).catch(() => {});
      } catch (e) { ctx.log(`voice join failed: ${e.stack || e.message}`); message.channel.send(`⚠️ Couldn't join voice: ${e.message}`).catch(() => {}); }
      return true;
    }
    try { voiceText.delete(message.guild.id); const left = voice.leave(message.guild.id); message.channel.send(left ? '👋 Left the voice channel.' : "I'm not in a voice channel.").catch(() => {}); } catch (_) {}
    return true;
  }

  client.on('messageCreate', async (message) => {
    if (message.author.id === client.user.id) return;
    if (message.author.bot && !isAllowedBot(message.author.username)) return;
    saveMemory(message, message.author.username, message.content);
    if (await handleControlCommands(message)) return;
    if (await handleVoiceCommands(message)) return;
    if (mutedChannels.has(message.channel.id)) return; // channel muted — ignore normal traffic (mention-commands above still work)
    // Drop messages @-directed at OTHER specific users/bots (there ARE user mentions but none
    // is us) — those aren't for us. Passive name-drops (no @mention) and @us still flow through
    // to shouldRespondTo, so autonomous participation is preserved. No typing on discarded msgs.
    if (ignoreOtherMentions && message.guild && message.mentions.users.size > 0 && !message.mentions.has(client.user)) return;
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
      const m = kind === 'photo' ? await channel.send({ content: caption || '', files: [filePath] }) : await channel.send(text);
      res.json({ ok: true, messageId: m.id });
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
