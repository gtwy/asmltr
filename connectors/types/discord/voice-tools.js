'use strict';
/**
 * Grok-callable Discord voice tools on the existing voice.js layer.
 * Bind live deps from the Discord connector process. Tests inject a mock voice.
 * Phone stubs live here and always refuse. No VoiceConnection in ivy-local MCP.
 */
const readline = require('readline');

const PHONE_REFUSE = 'Twilio not configured.';
const DISCORD_ONLY = 'Discord-only for now.';
const NOT_IN_VC = 'Hop into a voice channel first.';
const NOT_CONNECTED = 'Not connected to voice.';

const TOOLS = [
  {
    name: 'voice_join',
    description: 'Join the invoker current Discord voice channel and start listening. No channel-name argument — the invoker must already be in a VC. Replaces any prior connection for that guild.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'voice_leave',
    description: 'Leave the voice channel for this Discord turn guild. Safe if already left.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'voice_listen',
    description: 'Start or stop listening in the current guild voice connection. Does not leave the channel.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: { action: { type: 'string', enum: ['start', 'stop'] } },
      additionalProperties: false,
    },
  },
  {
    name: 'voice_speak',
    description: 'Speak short text in the current guild voice connection using the bound TTS engine. Honors barge-in/cancel. Fails if not connected.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: { text: { type: 'string', description: 'Spoken-style text; keep it short.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'voice_status',
    description: 'Voice connection status for this Discord turn guild. No secrets.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'phone_call',
    description: 'Place a phone call. Not configured.',
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string' }, text: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'phone_sms',
    description: 'Send an SMS. Not configured.',
    inputSchema: {
      type: 'object',
      required: ['to', 'text'],
      properties: { to: { type: 'string' }, text: { type: 'string' } },
      additionalProperties: false,
    },
  },
];
const BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

function ok(extra) {
  return Object.assign({ ok: true }, extra || {});
}
function fail(error, extra) {
  return Object.assign({ ok: false, error: String(error) }, extra || {});
}

function conversationKeyOf(turn) {
  if (!turn) return '';
  return String(
    turn.conversation_key
    || turn.conversationKey
    || turn.attachConversationKey
    || process.env.ASMLTR_ATTACH_CONVERSATION_KEY
    || ''
  );
}

function channelOf(turn) {
  if (!turn) return String(process.env.ASMLTR_ATTACH_CHANNEL || '');
  if (turn.channel) return String(turn.channel);
  return String(turn.attachChannel || process.env.ASMLTR_ATTACH_CHANNEL || '');
}

function isDiscordTurn(turn) {
  const ch = channelOf(turn).toLowerCase();
  if (ch === 'discord') return true;
  const key = conversationKeyOf(turn);
  if (/^discord(-voice)?:/i.test(key)) return true;
  if (turn && turn.channel_context && turn.channel_context.voice) return true;
  if (guildIdFromTurn(turn)) return true;
  return false;
}

function guildIdFromTurn(turn) {
  if (!turn) turn = {};
  if (turn.guildId) return String(turn.guildId);
  const ctx = turn.context || {};
  const sid = ctx.scope_id != null ? String(ctx.scope_id) : '';
  if (sid.startsWith('guild:')) return sid.slice(6);
  const cc = turn.channel_context || {};
  if (cc.guildId || cc.guild_id) return String(cc.guildId || cc.guild_id);
  const key = conversationKeyOf(turn);
  const voice = key.match(/^discord-voice:[^:]+:guild:(\d+)/i);
  if (voice) return voice[1];
  const envGuild = String(turn.attachGuild || process.env.ASMLTR_ATTACH_GUILD || '');
  if (envGuild) return envGuild;
  return '';
}

function senderIdFromTurn(turn) {
  if (!turn) turn = {};
  const s = turn.sender || {};
  return String(
    s.raw_id
    || s.id
    || turn.senderId
    || turn.attachSender
    || process.env.ASMLTR_ATTACH_SENDER
    || ''
  );
}

function turnFromEnv() {
  const key = process.env.ASMLTR_ATTACH_CONVERSATION_KEY || '';
  const guild = process.env.ASMLTR_ATTACH_GUILD || '';
  return {
    channel: process.env.ASMLTR_ATTACH_CHANNEL || '',
    conversation_key: key,
    attachGuild: guild,
    attachSender: process.env.ASMLTR_ATTACH_SENDER || '',
    attachTarget: process.env.ASMLTR_ATTACH_TARGET || '',
    sender: { raw_id: process.env.ASMLTR_ATTACH_SENDER || '' },
    context: guild ? { scope_id: 'guild:' + guild } : {},
    channel_context: {
      channelId: process.env.ASMLTR_ATTACH_TARGET || '',
      voice: /^discord-voice:/i.test(key),
    },
  };
}

function defaultVoice() {
  return require('./voice');
}

function defaultEngines() {
  try {
    const ve = require('../../../shared/speech/voice-engines');
    return {
      transcribeEngine: ve.resolve('realtime_transcribe').engine_id || '',
      ttsEngine: ve.resolve('synthesize').engine_id || '',
    };
  } catch (_) {
    return { transcribeEngine: '', ttsEngine: '' };
  }
}

function createRuntime(deps) {
  const d = deps || {};
  const voice = d.voice || defaultVoice;
  const getVoice = () => (typeof voice === 'function' ? voice() : voice);

  async function voice_join(_args, turn) {
    if (!isDiscordTurn(turn)) return fail(DISCORD_ONLY);
    const guildId = guildIdFromTurn(turn);
    if (!guildId) return fail(DISCORD_ONLY);
    if (typeof d.getInvokerVoiceChannel !== 'function') {
      return fail(NOT_IN_VC);
    }
    const vc = await d.getInvokerVoiceChannel(turn);
    if (!vc) return fail(NOT_IN_VC);
    const v = getVoice();
    await v.joinChannel(vc);
    const gid = String((vc.guild && vc.guild.id) || guildId);
    if (typeof d.startListening === 'function') await d.startListening(gid);
    else if (typeof v.startListening === 'function') v.startListening(gid, d.client, d.listenOptions || {});
    return ok({
      guildId: gid,
      channelId: String(vc.id || ''),
      channelName: String(vc.name || ''),
    });
  }

  async function voice_leave(_args, turn) {
    if (!isDiscordTurn(turn)) return fail(DISCORD_ONLY);
    const guildId = guildIdFromTurn(turn);
    if (!guildId) return fail(DISCORD_ONLY);
    const v = getVoice();
    const left = v.leave(guildId);
    if (!left) return ok({ alreadyLeft: true });
    return ok();
  }

  async function voice_listen(args, turn) {
    if (!isDiscordTurn(turn)) return fail(DISCORD_ONLY);
    const guildId = guildIdFromTurn(turn);
    if (!guildId) return fail(DISCORD_ONLY);
    const action = String((args && args.action) || '').toLowerCase();
    const v = getVoice();
    if (action === 'start') {
      if (!v.isConnected(guildId)) return fail(NOT_CONNECTED);
      if (typeof d.startListening === 'function') await d.startListening(guildId);
      else v.startListening(guildId, d.client, d.listenOptions || {});
      return ok({ listening: true });
    }
    if (action === 'stop') {
      v.stopListening(guildId);
      return ok({ listening: false });
    }
    return fail('action must be start or stop');
  }

  async function voice_speak(args, turn) {
    if (!isDiscordTurn(turn)) return fail(DISCORD_ONLY);
    const guildId = guildIdFromTurn(turn);
    if (!guildId) return fail(DISCORD_ONLY);
    const text = args && args.text != null ? String(args.text) : '';
    if (!text.trim()) return fail('text is required');
    const v = getVoice();
    if (!v.isConnected(guildId)) return fail(NOT_CONNECTED);
    const synth = d.synthesize;
    if (typeof synth !== 'function') return fail('TTS unavailable.');
    v.startSpeech(guildId);
    try {
      const audio = await synth(text);
      if (typeof v.isSpeaking === 'function' && !v.isSpeaking(guildId)) {
        return fail('cancelled', { cancelled: true });
      }
      if (!audio) return fail('TTS failed.');
      await v.speak(guildId, audio);
      return ok();
    } finally {
      v.endSpeech(guildId);
    }
  }

  async function voice_status(_args, turn) {
    if (!isDiscordTurn(turn)) return fail(DISCORD_ONLY);
    const guildId = guildIdFromTurn(turn);
    if (!guildId) return fail(DISCORD_ONLY);
    const v = getVoice();
    const connected = !!v.isConnected(guildId);
    const listening = typeof v.isListening === 'function' ? !!v.isListening(guildId) : false;
    const speaking = typeof v.isSpeaking === 'function' ? !!v.isSpeaking(guildId) : false;
    let channelId = '';
    let channelName = '';
    if (typeof d.getChannelInfo === 'function') {
      try {
        const info = await d.getChannelInfo(guildId);
        if (info) {
          channelId = String(info.channelId || '');
          channelName = String(info.channelName || '');
        }
      } catch (_) {}
    }
    if (!channelId && typeof v.channelIdOf === 'function') {
      channelId = String(v.channelIdOf(guildId) || '');
    }
    const rawEngines = (typeof d.engines === 'function' ? d.engines() : d.engines);
    const engines = ((rawEngines && typeof rawEngines.then === 'function') ? await rawEngines : rawEngines) || defaultEngines();
    return {
      connected,
      listening,
      speaking,
      guildId: String(guildId),
      channelId,
      channelName,
      transcribeEngine: String((engines && engines.transcribeEngine) || ''),
      ttsEngine: String((engines && engines.ttsEngine) || ''),
    };
  }

  async function phone_call() { return fail(PHONE_REFUSE); }
  async function phone_sms() { return fail(PHONE_REFUSE); }

  const handlers = {
    voice_join, voice_leave, voice_listen, voice_speak, voice_status, phone_call, phone_sms,
  };

  async function invoke(name, args, turn) {
    const h = handlers[name];
    if (!h) return fail('unknown tool: ' + name);
    return h(args || {}, turn || {});
  }

  return { invoke, handlers };
}

let _bound = createRuntime({});
let _live = false;

function bind(deps) {
  _bound = createRuntime(deps || {});
  _live = !!(deps && typeof deps.getInvokerVoiceChannel === 'function');
  return _bound;
}

function invokeLocal(name, args, turn) {
  return _bound.invoke(name, args, turn);
}

async function findDiscordVoiceUrl() {
  if (process.env.ASMLTR_DISCORD_VOICE_URL) return String(process.env.ASMLTR_DISCORD_VOICE_URL);
  if (process.env.ASMLTR_DISCORD_HTTP_PORT) {
    return 'http://127.0.0.1:' + String(process.env.ASMLTR_DISCORD_HTTP_PORT) + '/voice';
  }
  const manager = String(process.env.ASMLTR_MANAGER_BASE || 'http://127.0.0.1:3024').replace(/\/+$/, '');
  try {
    const { connectorAuthHeaders } = require('../../../shared/connector-http-auth');
    const r = await fetch(manager + '/instances', { headers: connectorAuthHeaders() });
    const j = await r.json();
    const inst = (j.instances || []).find((i) => i && i.type === 'discord' && i.enabled !== false);
    const port = (inst && inst.config && inst.config.http_port) || 3016;
    return 'http://127.0.0.1:' + String(port) + '/voice';
  } catch (_) {
    return 'http://127.0.0.1:3016/voice';
  }
}

async function postDiscord(name, args, turn) {
  const { connectorAuthHeaders } = require('../../../shared/connector-http-auth');
  const url = await findDiscordVoiceUrl();
  const r = await fetch(url, {
    method: 'POST',
    headers: connectorAuthHeaders(),
    body: JSON.stringify({ tool: name, args: args || {}, turn: turn || turnFromEnv() }),
  });
  const j = await r.json().catch(() => null);
  if (!j) return { ok: false, error: 'discord voice HTTP ' + r.status };
  return j;
}

function invoke(name, args, turn) {
  if (name === 'phone_call' || name === 'phone_sms') return invokeLocal(name, args, turn);
  if (_live) return invokeLocal(name, args, turn);
  return postDiscord(name, args, turn);
}


const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const mcpOk = (id, result) => send({ jsonrpc: '2.0', id, result });
const mcpFail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handleMcp(msg, runtime) {
  const rt = runtime || _bound;
  if (msg.method === 'notifications/initialized' || msg.id === undefined) return;
  switch (msg.method) {
    case 'initialize':
      return mcpOk(msg.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'asmltr-voice', version: '1.0.0' },
      });
    case 'ping':
      return mcpOk(msg.id, {});
    case 'tools/list':
      return mcpOk(msg.id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const name = (msg.params || {}).name;
      if (!BY_NAME[name]) return mcpFail(msg.id, -32602, 'unknown tool: ' + name);
      const r = await rt.invoke(name, (msg.params || {}).arguments || {}, turnFromEnv());
      const isError = r && r.ok === false;
      return mcpOk(msg.id, { content: [{ type: 'text', text: JSON.stringify(r) }], isError });
    }
    default:
      return mcpFail(msg.id, -32601, 'method not found: ' + msg.method);
  }
}

if (require.main === module) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const s = line.trim();
    if (!s) return;
    let msg;
    try { msg = JSON.parse(s); } catch { return; }
    Promise.resolve(handleMcp(msg)).catch(() => {});
  });
  rl.on('close', () => process.exit(0));
}

module.exports = {
  TOOLS,
  BY_NAME,
  PHONE_REFUSE,
  DISCORD_ONLY,
  NOT_IN_VC,
  NOT_CONNECTED,
  guildIdFromTurn,
  senderIdFromTurn,
  isDiscordTurn,
  conversationKeyOf,
  turnFromEnv,
  createRuntime,
  bind,
  invoke,
  invokeLocal,
  findDiscordVoiceUrl,
  handleMcp,
};
