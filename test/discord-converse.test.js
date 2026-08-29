'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('index.js binds converse when vault key present and skips handleStream + ElevenLabs TTS', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  assert.match(src, /require\('\.\.\/\.\.\/\.\.\/shared\/speech\/converse-grok'\)/);
  assert.match(src, /vault\.getSecret\('xai_voice_api_key'/);
  assert.match(src, /async function tryOpenConverse/);
  assert.match(src, /converse bound/);
  assert.match(src, /skip handleStream \+ ElevenLabs/);
  assert.match(src, /if \(converseSessions\.has\(guildId\)\)/);
  assert.match(src, /shouldRelayPcm/);
  assert.match(src, /pushPcm24Play/);
  assert.match(src, /voice=ara/);
  assert.doesNotMatch(src, /voice:\s*'eve'/);
  assert.doesNotMatch(src, /process\.env\.XAI_API_KEY/);
  const handle = src.slice(src.indexOf('async function handleVoiceUtterance'), src.indexOf('async function engineKeys'));
  const convReturn = handle.indexOf('if (converseSessions.has(guildId))');
  const streamAt = handle.indexOf('await ctx.core.handleStream');
  assert.ok(convReturn >= 0, 'converse short-circuit in handleVoiceUtterance');
  assert.ok(streamAt > convReturn, 'handleStream still present for Flux fallback, after converse return');
});

test('voice.js converse listen path skips Flux and plays PCM 24k', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/voice.js'), 'utf8');
  assert.match(src, /function converseSpeaking/);
  assert.match(src, /if \(converse\)/);
  assert.match(src, /pushPcm24Play/);
  assert.match(src, /pcm24MonoToPcm48Stereo/);
  assert.match(src, /onPcm24/);
  assert.match(src, /allowPcm/);
});

test('join-voice stays owner-only; spoken tools stay empty on the WS', () => {
  const index = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  const ownerBlock = index.slice(index.indexOf('const OWNER_ONLY_CMDS'), index.indexOf('const meta'));
  assert.match(ownerBlock, /'join-voice'/);
  const grok = fs.readFileSync(path.join(__dirname, '../shared/speech/converse-grok.js'), 'utf8');
  assert.match(grok, /tools:\s*\[\]/);
  assert.equal(/type:\s*'web_search'/.test(grok), false);
  assert.equal(/type:\s*'mcp'/.test(grok), false);
});

test('grok CLI launchEnv still strips converse keys (source)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../core/src/engines/grok.js'), 'utf8');
  assert.match(src, /delete env\.XAI_API_KEY/);
  assert.match(src, /delete env\.XAI_VOICE_API_KEY/);
  assert.match(src, /delete env\.xai_voice_api_key/);
});

test('Live name is grab not keepalive: lastSpeakerId converseBound while socket up', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  assert.match(src, /converseBound:\s*converseSessions\.has\(guildId\)/);
  assert.match(src, /lastSpeakerFromWindow/);
  const grok = fs.readFileSync(path.join(__dirname, '../shared/speech/converse-grok.js'), 'utf8');
  assert.match(grok, /keyterms/);
  assert.match(grok, /'Ivy'/);
  const wake = fs.readFileSync(path.join(__dirname, '../shared/speech/wake.js'), 'utf8');
  assert.match(wake, /IVY_ALIASES/);
  assert.match(wake, /'iv'/);
});
