'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  textEnvelope, isUntrusted, toolsForSpeaker, speakerIdentityLine,
  siloRecallBlock, buildLiveInstructions, executeFunctionCall,
} = require('../shared/speech/live-tools');
const { asRealtimeFunctions, buildSessionUpdate } = require('../shared/speech/converse-grok');
const { listTools } = require('../mcp/toolbelt-server');
const { policyFor, isDiscordVoice } = require('../shared/media-allow');

test('untrusted speaker → [] tools; owner gets function-type asmltr tools', () => {
  const env = textEnvelope({ instanceId: 'ivy', guildId: 'g1', channelId: 'c1', userId: '42', username: 'james' });
  assert.equal(isDiscordVoice(env), false);
  assert.equal(env.conversation_key.startsWith('discord-voice:'), false);
  assert.equal(env.channel_context.voice, undefined);
  assert.deepEqual(toolsForSpeaker({ is_default: true }, env), []);
  assert.deepEqual(toolsForSpeaker({ revoked: true, user_key: 'x' }, env), []);
  assert.deepEqual(toolsForSpeaker(null, env), []);
  const owner = { bypass_moderation: true, user_key: 'owner', is_default: false };
  const tools = toolsForSpeaker(owner, env);
  assert.ok(tools.length > 0);
  assert.equal(tools.every((t) => t.type === 'function'), true);
  assert.equal(tools.some((t) => t.type === 'web_search' || t.name === 'web_search'), false);
  assert.equal(tools.some((t) => t.type === 'x_search' || t.name === 'x_search'), false);
  assert.equal(tools.some((t) => t.type === 'mcp' || t.name === 'mcp'), false);
  assert.ok(tools.some((t) => t.name === 'asmltr_sessions'));
  const listed = listTools(policyFor(env, owner).deny);
  assert.deepEqual(asRealtimeFunctions(listed).map((t) => t.name).sort(), tools.map((t) => t.name).sort());
});

test('denied tool is not executed (mock)', async () => {
  const env = textEnvelope({ instanceId: 'ivy', guildId: 'g1', channelId: 'c1', userId: '99', username: 'guest' });
  const resolved = { is_default: false, bypass_moderation: false, user_key: 'guest', permissions: [] };
  let ran = 0;
  const out = await executeFunctionCall({
    name: 'asmltr_send',
    args: { channel: 'discord', target: 'x', text: 'hi' },
    resolved,
    envelope: env,
    invoke: async () => { ran += 1; return { ok: true, text: 'sent' }; },
  });
  assert.equal(ran, 0);
  assert.match(out, /denied/);
});

test('owner tool executes through invoke; native names denied', async () => {
  const env = textEnvelope({ instanceId: 'ivy', guildId: 'g1', channelId: 'c1', userId: '1', username: 'owner' });
  const owner = { bypass_moderation: true, user_key: 'owner', is_default: false };
  let ran = 0;
  const out = await executeFunctionCall({
    name: 'asmltr_sessions',
    args: {},
    resolved: owner,
    envelope: env,
    invoke: async (name) => { ran += 1; return { ok: true, text: 'ok:' + name }; },
  });
  assert.equal(ran, 1);
  assert.match(out, /ok:asmltr_sessions/);
  const native = await executeFunctionCall({
    name: 'web_search',
    args: {},
    resolved: owner,
    envelope: env,
    invoke: async () => { ran += 1; return { ok: true }; },
  });
  assert.equal(ran, 1);
  assert.match(native, /denied/);
});

test('instructions contain identity/silo when speaker bound', () => {
  const line = speakerIdentityLine({ channel: 'discord', speakerId: '42', speakerName: 'James' });
  assert.match(line, /CURRENT SPEAKER/);
  assert.match(line, /James/);
  assert.match(line, /discord:42/);
  const silo = siloRecallBlock('## turn one');
  assert.match(silo, /PRIOR CONVERSATION/);
  assert.match(silo, /turn one/);
  const ident = '## IDENTITY\nYou are **Ivy**.';
  const built = buildLiveInstructions({
    voiceGuidance: 'Keep it short.',
    identity: ident,
    speakerLine: line,
    siloRecall: silo,
  });
  assert.match(built, /IDENTITY/);
  assert.match(built, /CURRENT SPEAKER/);
  assert.match(built, /PRIOR CONVERSATION/);
});

test('Flux handleStream voice deny-all remains; Live text envelope does not trip it', () => {
  const voiceEnv = {
    channel: 'discord',
    conversation_key: 'discord-voice:ivy:guild:1',
    channel_context: { voice: true },
  };
  const owner = { bypass_moderation: true, user_key: 'owner' };
  const v = policyFor(voiceEnv, owner);
  assert.equal(v.deny.all, true);
  const text = textEnvelope({ instanceId: 'ivy', guildId: '1', channelId: 'c', userId: '1' });
  const t = policyFor(text, owner);
  assert.equal(!!t.deny.all, false);
});

test('session.update still ara / 48k / interrupt_response false with function tools', () => {
  const u = buildSessionUpdate({
    tools: [{ type: 'function', name: 'asmltr_map', description: 'm', parameters: { type: 'object', properties: {} } }],
    instructions: 'hi',
  });
  assert.equal(u.session.voice, 'ara');
  assert.equal(u.session.turn_detection.interrupt_response, false);
  assert.equal(u.session.audio.input.format.rate, 48000);
  assert.equal(u.session.tools[0].type, 'function');
  assert.equal(u.session.tools[0].name, 'asmltr_map');
});

test('join-voice still owner-only; no process.env.XAI_API_KEY on live path', () => {
  const idx = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  const ownerBlock = idx.slice(idx.indexOf('const OWNER_ONLY_CMDS'), idx.indexOf('const meta'));
  assert.match(ownerBlock, /join-voice/);
  assert.doesNotMatch(idx, /process\.env\.XAI_API_KEY/);
  const grok = fs.readFileSync(path.join(__dirname, '../shared/speech/converse-grok.js'), 'utf8');
  assert.doesNotMatch(grok, /=\s*process\.env\.XAI_API_KEY/);
  const belt = fs.readFileSync(path.join(__dirname, '../mcp/toolbelt-server.js'), 'utf8');
  assert.match(belt, /delete env\.XAI_API_KEY/);
  assert.match(belt, /delete env\.XAI_VOICE_API_KEY/);
  assert.match(belt, /delete env\.xai_voice_api_key/);
});
