'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  createRuntime, guildIdFromTurn, senderIdFromTurn, isDiscordTurn,
  PHONE_REFUSE, DISCORD_ONLY, NOT_IN_VC, NOT_CONNECTED,
  invoke, bind, findDiscordVoiceUrl,
} = require('../connectors/types/discord/voice-tools');

function mockVoice(init = {}) {
  const connected = new Set(init.connected || []);
  const listening = new Set(init.listening || []);
  const speaking = new Map();
  const spoken = [];
  let joinCalls = 0;
  return {
    spoken,
    connected,
    listening,
    speaking,
    joinCalls: () => joinCalls,
    async joinChannel(vc) {
      joinCalls += 1;
      const gid = String(vc.guild.id);
      connected.add(gid);
      this._channelId = String(vc.id);
      this._channelName = String(vc.name || '');
      this._guildId = gid;
    },
    leave(guildId) {
      const gid = String(guildId);
      const had = connected.has(gid);
      connected.delete(gid);
      listening.delete(gid);
      speaking.delete(gid);
      return had;
    },
    isConnected(guildId) { return connected.has(String(guildId)); },
    isListening(guildId) { return listening.has(String(guildId)); },
    isSpeaking(guildId) { return !!speaking.get(String(guildId)); },
    startListening(guildId) { listening.add(String(guildId)); return true; },
    stopListening(guildId) { listening.delete(String(guildId)); },
    startSpeech(guildId) { speaking.set(String(guildId), true); },
    stopSpeech(guildId) { speaking.set(String(guildId), false); },
    endSpeech(guildId) { speaking.delete(String(guildId)); },
    async speak(guildId, buf) { spoken.push({ guildId: String(guildId), buf }); },
    channelIdOf(guildId) { return this.isConnected(guildId) ? (this._channelId || null) : null; },
  };
}

const discordTurn = {
  channel: 'discord',
  guildId: '99',
  sender: { raw_id: '42' },
  context: { scope_id: 'guild:99' },
  conversation_key: 'discord:inst:channel:7',
};

function runtime(opts = {}) {
  const voice = opts.voice || mockVoice();
  const started = [];
  return createRuntime({
    voice,
    getInvokerVoiceChannel: opts.getInvokerVoiceChannel !== undefined
      ? opts.getInvokerVoiceChannel
      : async () => ({ id: 'vc1', name: 'General', guild: { id: '99' } }),
    startListening: opts.startListening || (async (gid) => { started.push(gid); voice.startListening(gid); }),
    synthesize: opts.synthesize || (async (text) => Buffer.from(String(text))),
    getChannelInfo: opts.getChannelInfo || (async () => ({
      channelId: voice._channelId || '',
      channelName: voice._channelName || '',
    })),
    engines: opts.engines || { transcribeEngine: 'openai-live-transcribe', ttsEngine: 'openai-tts' },
    _started: started,
    _voice: voice,
  });
}

test('refuse-if-not-in-VC', async () => {
  const rt = runtime({ getInvokerVoiceChannel: async () => null });
  const r = await rt.invoke('voice_join', {}, discordTurn);
  assert.equal(r.ok, false);
  assert.equal(r.error, NOT_IN_VC);
  assert.equal(rt.handlers ? true : true, true);
});

test('voice_join refuses when getInvokerVoiceChannel is missing', async () => {
  const voice = mockVoice();
  const rt = createRuntime({ voice });
  const r = await rt.invoke('voice_join', {}, discordTurn);
  assert.equal(r.ok, false);
  assert.equal(r.error, NOT_IN_VC);
  assert.equal(voice.joinCalls(), 0);
});

test('voice_join joins invoker VC and starts listening', async () => {
  const voice = mockVoice();
  const started = [];
  const rt = createRuntime({
    voice,
    getInvokerVoiceChannel: async () => ({ id: 'vc1', name: 'General', guild: { id: '99' } }),
    startListening: async (gid) => { started.push(gid); voice.startListening(gid); },
  });
  const r = await rt.invoke('voice_join', {}, discordTurn);
  assert.deepEqual(r, { ok: true, guildId: '99', channelId: 'vc1', channelName: 'General' });
  assert.equal(voice.isConnected('99'), true);
  assert.deepEqual(started, ['99']);
  assert.equal(voice.isListening('99'), true);
});

test('leave when not connected', async () => {
  const rt = runtime({ voice: mockVoice() });
  const r = await rt.invoke('voice_leave', {}, discordTurn);
  assert.equal(r.ok, true);
  assert.equal(r.alreadyLeft, true);
});

test('voice_leave after join returns ok', async () => {
  const voice = mockVoice({ connected: ['99'] });
  const rt = runtime({ voice });
  const r = await rt.invoke('voice_leave', {}, discordTurn);
  assert.deepEqual(r, { ok: true });
  assert.equal(voice.isConnected('99'), false);
});

test('phone stub refuse', async () => {
  const rt = runtime();
  const call = await rt.invoke('phone_call', { to: '+10000000000' }, discordTurn);
  const sms = await rt.invoke('phone_sms', { to: '+10000000000', text: 'hi' }, discordTurn);
  assert.equal(call.ok, false);
  assert.equal(call.error, PHONE_REFUSE);
  assert.equal(sms.ok, false);
  assert.equal(sms.error, PHONE_REFUSE);
});

test('status shape', async () => {
  const voice = mockVoice({ connected: ['99'], listening: ['99'] });
  voice._channelId = 'vc1';
  voice._channelName = 'General';
  const rt = runtime({ voice });
  const r = await rt.invoke('voice_status', {}, discordTurn);
  assert.deepEqual(r, {
    connected: true,
    listening: true,
    speaking: false,
    guildId: '99',
    channelId: 'vc1',
    channelName: 'General',
    transcribeEngine: 'openai-live-transcribe',
    ttsEngine: 'openai-tts',
  });
  for (const k of ['connected', 'listening', 'speaking', 'guildId', 'channelId', 'channelName', 'transcribeEngine', 'ttsEngine']) {
    assert.ok(Object.prototype.hasOwnProperty.call(r, k), k);
  }
  assert.equal(JSON.stringify(r).includes('key'), false);
  assert.equal(JSON.stringify(r).includes('token'), false);
});

test('non-Discord turn refuses', async () => {
  const rt = runtime();
  const r = await rt.invoke('voice_status', {}, { channel: 'email' });
  assert.equal(r.ok, false);
  assert.equal(r.error, DISCORD_ONLY);
});

test('guildId from text scope_id and discord-voice conversation_key', () => {
  assert.equal(guildIdFromTurn({ context: { scope_id: 'guild:123' } }), '123');
  assert.equal(guildIdFromTurn({
    conversation_key: 'discord-voice:inst:guild:456',
  }), '456');
  assert.equal(isDiscordTurn({ conversation_key: 'discord-voice:inst:guild:456' }), true);
  assert.equal(isDiscordTurn({ channel: 'telegram' }), false);
});

test('voice_speak fails if not connected', async () => {
  const rt = runtime({ voice: mockVoice() });
  const r = await rt.invoke('voice_speak', { text: 'hi' }, discordTurn);
  assert.equal(r.ok, false);
  assert.match(r.error, /not connected/i);
});

test('voice_speak honors cancel before playback', async () => {
  const voice = mockVoice({ connected: ['99'] });
  const rt = createRuntime({
    voice,
    synthesize: async () => {
      voice.stopSpeech('99');
      return Buffer.from('x');
    },
  });
  const r = await rt.invoke('voice_speak', { text: 'hi' }, discordTurn);
  assert.equal(r.ok, false);
  assert.equal(r.cancelled, true);
  assert.equal(voice.spoken.length, 0);
});



test('voice_listen start fails if not connected', async () => {
  const rt = runtime({ voice: mockVoice() });
  const r = await rt.invoke('voice_listen', { action: 'start' }, discordTurn);
  assert.equal(r.ok, false);
  assert.equal(r.error, NOT_CONNECTED);
});

test('join payload carries guildId and sender raw_id', () => {
  assert.equal(guildIdFromTurn(discordTurn), '99');
  assert.equal(senderIdFromTurn(discordTurn), '42');
});

function withFetch(fn) {
  return async () => {
    const prevUrl = process.env.ASMLTR_DISCORD_VOICE_URL;
    const prevPort = process.env.ASMLTR_DISCORD_HTTP_PORT;
    const orig = global.fetch;
    process.env.ASMLTR_DISCORD_VOICE_URL = 'http://127.0.0.1:3016/voice';
    delete process.env.ASMLTR_DISCORD_HTTP_PORT;
    bind({});
    try {
      await fn();
    } finally {
      global.fetch = orig;
      bind({});
      if (prevUrl == null) delete process.env.ASMLTR_DISCORD_VOICE_URL;
      else process.env.ASMLTR_DISCORD_VOICE_URL = prevUrl;
      if (prevPort == null) delete process.env.ASMLTR_DISCORD_HTTP_PORT;
      else process.env.ASMLTR_DISCORD_HTTP_PORT = prevPort;
    }
  };
}

test('IPC join payload includes guildId+userId', withFetch(async () => {
  const posts = [];
  global.fetch = async (url, opts) => {
    posts.push({ url: String(url), body: JSON.parse(opts.body) });
    return { status: 200, json: async () => ({ ok: true, guildId: '99', channelId: 'vc1', channelName: 'General' }) };
  };
  const r = await invoke('voice_join', {}, discordTurn);
  assert.equal(r.ok, true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'http://127.0.0.1:3016/voice');
  assert.equal(posts[0].body.tool, 'voice_join');
  assert.equal(posts[0].body.turn.guildId, '99');
  assert.equal(posts[0].body.turn.sender.raw_id, '42');
}));

test('IPC join refuses when not in VC', withFetch(async () => {
  global.fetch = async () => ({ status: 200, json: async () => ({ ok: false, error: NOT_IN_VC }) });
  const r = await invoke('voice_join', {}, discordTurn);
  assert.equal(r.ok, false);
  assert.equal(r.error, NOT_IN_VC);
}));

test('IPC speak/listen require connected', withFetch(async () => {
  global.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.tool === 'voice_speak' || (body.tool === 'voice_listen' && body.args && body.args.action === 'start')) {
      return { status: 200, json: async () => ({ ok: false, error: NOT_CONNECTED }) };
    }
    return { status: 200, json: async () => ({ ok: true }) };
  };
  const speak = await invoke('voice_speak', { text: 'hi' }, discordTurn);
  const listen = await invoke('voice_listen', { action: 'start' }, discordTurn);
  assert.equal(speak.ok, false);
  assert.match(speak.error, /not connected/i);
  assert.equal(listen.ok, false);
  assert.match(listen.error, /not connected/i);
}));

test('phone stubs stay local (no IPC fetch)', withFetch(async () => {
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls += 1; throw new Error('IPC should not run for phone stubs'); };
  const call = await invoke('phone_call', { to: '+10000000000' }, discordTurn);
  const sms = await invoke('phone_sms', { to: '+10000000000', text: 'hi' }, discordTurn);
  assert.equal(call.ok, false);
  assert.equal(call.error, PHONE_REFUSE);
  assert.equal(sms.ok, false);
  assert.equal(sms.error, PHONE_REFUSE);
  assert.equal(fetchCalls, 0);
}));

test('findDiscordVoiceUrl prefers env then 127.0.0.1:3016/voice', async () => {
  const prevUrl = process.env.ASMLTR_DISCORD_VOICE_URL;
  const prevPort = process.env.ASMLTR_DISCORD_HTTP_PORT;
  try {
    process.env.ASMLTR_DISCORD_VOICE_URL = 'http://127.0.0.1:3999/voice';
    assert.equal(await findDiscordVoiceUrl(), 'http://127.0.0.1:3999/voice');
    delete process.env.ASMLTR_DISCORD_VOICE_URL;
    process.env.ASMLTR_DISCORD_HTTP_PORT = '3016';
    assert.equal(await findDiscordVoiceUrl(), 'http://127.0.0.1:3016/voice');
    delete process.env.ASMLTR_DISCORD_HTTP_PORT;
    const orig = global.fetch;
    global.fetch = async () => { throw new Error('manager down'); };
    try {
      assert.equal(await findDiscordVoiceUrl(), 'http://127.0.0.1:3016/voice');
    } finally {
      global.fetch = orig;
    }
  } finally {
    if (prevUrl == null) delete process.env.ASMLTR_DISCORD_VOICE_URL;
    else process.env.ASMLTR_DISCORD_VOICE_URL = prevUrl;
    if (prevPort == null) delete process.env.ASMLTR_DISCORD_HTTP_PORT;
    else process.env.ASMLTR_DISCORD_HTTP_PORT = prevPort;
  }
});

test('discord connector binds voice-tools; toolbelt lists voice_* and phone stubs', () => {
  const idx = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  assert.match(idx, /voice-tools/);
  assert.match(idx, /voiceTools\.bind/);
  assert.match(idx, /app\.post\('\/voice'/);
  assert.match(idx, /voiceTools\.invokeLocal/);
  assert.match(idx, /listen\(cfg\.http_port \|\| 3016, '127\.0\.0\.1'/);
  const belt = fs.readFileSync(path.join(__dirname, '../mcp/toolbelt-server.js'), 'utf8');
  assert.match(belt, /voice_join/);
  assert.match(belt, /voice_leave/);
  assert.match(belt, /voice_listen/);
  assert.match(belt, /voice_speak/);
  assert.match(belt, /voice_status/);
  assert.match(belt, /phone_call/);
  assert.match(belt, /phone_sms/);
});
