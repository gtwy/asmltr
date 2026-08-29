'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const discord = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
const voice = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/voice.js'), 'utf8');
const engines = fs.readFileSync(path.join(__dirname, '../shared/speech/voice-engines.js'), 'utf8');
const converse = fs.readFileSync(path.join(__dirname, '../shared/speech/converse-grok.js'), 'utf8');
const grok = fs.readFileSync(path.join(__dirname, '../core/src/engines/grok.js'), 'utf8');

test('Live converse: ara session, vault xai_voice_api_key, no eve default, no ElevenLabs voice_id', () => {
  assert.match(converse, /voice: LIVE_VOICE/);
  assert.match(converse, /const LIVE_VOICE = 'ara'/);
  assert.match(converse, /grok-voice-think-fast-2\.0/);
  assert.match(converse, /require\('\.\.\/vault'\)\.getSecret/);
  assert.match(converse, /KEY_NAME = 'xai_voice_api_key'/);
  assert.match(converse, /shared\/vault/);
  const code = converse.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(code.includes('XAI_API_KEY'), false);
  assert.equal(/voice:\s*['"]eve['"]/.test(code), false);
  assert.equal(code.toLowerCase().includes('elevenlabs'), false);
  assert.match(converse, /tools: \[\]/);
  assert.match(converse, /server_vad/);
  assert.match(converse, /effort: 'none'/);
});

test('converse bound skips handleStream + ElevenLabs HTTP TTS; Flux path remains when unbound', () => {
  assert.match(discord, /skip handleStream \+ ElevenLabs HTTP TTS/);
  assert.match(discord, /flushBurstToConverse/);
  assert.match(discord, /const convLive = converseSessions\.get\(guildId\)/);
  assert.match(discord, /ctx\.core\.handleStream/);
  assert.match(discord, /elevenLabsTTS/);
  assert.match(discord, /converseGrok\.openSession/);
  assert.match(discord, /xai_voice_api_key/);
  assert.equal(discord.includes('XAI_API_KEY'), false);
  assert.equal(/new WebSocket/.test(discord), false);
});

test('join-voice stays owner-only; last-speaker PCM only into WS; transcribe-off stays', () => {
  assert.match(discord, /OWNER_ONLY_CMDS/);
  const ownerBlock = discord.slice(discord.indexOf('const OWNER_ONLY_CMDS'), discord.indexOf('const meta'));
  assert.match(ownerBlock, /join-voice/);
  assert.match(discord, /if \(OWNER_ONLY_CMDS\.has\(cmd\) && !\(await isOwner\(message\)\)\)/);
  assert.match(discord, /shouldRelayPcm/);
  assert.match(discord, /isLastSpeakerRelay/);
  assert.match(discord, /shouldPostLive/);
  assert.match(discord, /transcribe-off/);
  assert.match(voice, /shouldRelayPcm\(userId\)/);
  assert.match(voice, /converse\.pushPcm24/);
  assert.match(voice, /flushBurstToConverse/);
});

test('no second Discord client, no Pipecat, no discord.py; grok CLI still strips XAI_API_KEY', () => {
  assert.equal(/discord\.py|pipecat|second Discord client/i.test(discord), false);
  assert.equal(/new Client\(/.test(discord.split("new Client(")[2] || ''), false); // only one construction after first
  assert.equal(discord.split('new Client(').length, 2); // declaration + one construct
  assert.match(grok, /delete env\.XAI_API_KEY/);
  assert.equal(engines.includes('XAI_API_KEY'), false);
  assert.match(engines, /xai_voice_api_key/);
  assert.match(engines, /'grok-voice'/);
  assert.match(engines, /IMPLEMENTED.*grok-voice/);
});

test('pcm24MonoToPcm48Stereo doubles rate and stereoizes', () => {
  const { pcm24MonoToPcm48Stereo } = require('../connectors/types/discord/voice');
  const src = Buffer.alloc(4);
  src.writeInt16LE(100, 0);
  src.writeInt16LE(-100, 2);
  const out = pcm24MonoToPcm48Stereo(src);
  assert.equal(out.length, 16);
  assert.equal(out.readInt16LE(0), 100);
  assert.equal(out.readInt16LE(2), 100);
  assert.equal(out.readInt16LE(4), 100);
  assert.equal(out.readInt16LE(6), 100);
  assert.equal(out.readInt16LE(8), -100);
});
