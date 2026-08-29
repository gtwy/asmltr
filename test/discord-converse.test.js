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
  assert.match(src, /open-line/);
  assert.match(src, /Just talk/);
  const pcm = src.slice(src.indexOf("onPcm24:"), src.indexOf("onBargeIn:"));
  assert.match(pcm, /conv.pushPcm24/);
  assert.equal(/shouldRelayPcm/.test(pcm), false);
  assert.equal(/bindLiveSpeaker/.test(pcm), false);
  assert.equal(/applyLiveSpeaker/.test(pcm), false);
  assert.equal(/ctx\.core\.resolve/.test(pcm), false);
  assert.equal(/recallForInject/.test(pcm), false);
  assert.match(pcm, /isSpeaking\(guildId\)/);
  assert.match(src, /pushPcm24Play/);
  assert.match(src, /voice=ara/);
  assert.match(src, /realtime: conv \? false/);
  assert.match(src, /converse: !!conv/);
  assert.match(src, /forceMessage\("ivy.s here"\)/);
  assert.doesNotMatch(src, /voice:\s*'eve'/);
  assert.doesNotMatch(src, /process\.env\.XAI_API_KEY/);
  const handle = src.slice(src.indexOf('async function handleVoiceUtterance'), src.indexOf('async function engineKeys'));
  const convReturn = handle.indexOf('if (converseSessions.has(guildId))');
  const streamAt = handle.indexOf('await ctx.core.handleStream');
  assert.ok(convReturn >= 0, 'converse short-circuit in handleVoiceUtterance');
  assert.ok(streamAt > convReturn, 'handleStream still present for Flux fallback, after converse return');
});

test('voice.js converse listen path skips Flux and plays PCM 48k native', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/voice.js'), 'utf8');
  assert.match(src, /function converseSpeaking/);
  assert.match(src, /if \(converse\)/);
  assert.match(src, /pushPcm24Play/);
  assert.match(src, /pcm48MonoToPcm48Stereo/);
  assert.match(src, /pcm48StereoToPcm48Mono/);
  assert.match(src, /onPcm24/);
  assert.match(src, /allowPcm/);
});

test('join-voice stays owner-only; session.tools never native web_search/x_search/mcp', () => {
  const index = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  const ownerBlock = index.slice(index.indexOf('const OWNER_ONLY_CMDS'), index.indexOf('const meta'));
  assert.match(ownerBlock, /'join-voice'/);
  const grok = fs.readFileSync(path.join(__dirname, '../shared/speech/converse-grok.js'), 'utf8');
  assert.match(grok, /asRealtimeFunctions/);
  assert.equal(/type:\s*'web_search'/.test(grok), false);
  assert.equal(/type:\s*'x_search'/.test(grok), false);
  assert.equal(/type:\s*'mcp'/.test(grok), false);
  assert.match(index, /live-tools/);
  assert.match(index, /refreshRoomInstructions/);
  assert.match(index, /liveRoomLine/);
  assert.match(index, /onFunctionCall/);
  assert.match(index, /VOICE_GUIDANCE_LIVE/);
  assert.doesNotMatch(index, /process\.env\.XAI_API_KEY/);
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

test('Live user transcript edits in place; 1:1 room line; no stay-silent-among-themselves default', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  assert.match(src, /upsertLiveUserLine/);
  assert.match(src, /liveRoomLine/);
  assert.match(src, /countHumansNow/);
  assert.doesNotMatch(src, /Stay silent when the humans are talking among themselves\. No wake word is required/);
  assert.match(src, /solo = countHumansNow\(guildId\) <= 1/);
});

test("Live 1:1 speaking-stop forces response.create", () => {
  const fs = require("fs");
  const src = fs.readFileSync(require("path").join(__dirname, "../connectors/types/discord/index.js"), "utf8");
  assert.match(src, /onSpeechEnd/);
  assert.match(src, /createResponse/);
  assert.match(src, /1:1 speaking-stop/);
  const voice = fs.readFileSync(require("path").join(__dirname, "../connectors/types/discord/voice.js"), "utf8");
  assert.match(voice, /onSpeechEnd/);
});

test('Live pack: grok-only, WS reopen, scribe edit, speaking-stop', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  assert.match(src, /grok-only Live \(no Flux\)/);
  assert.match(src, /converse reopening \(still in VC\)/);
  assert.match(src, /converse WS closed code=/);
  assert.match(src, /PCM → WS bytes=/);
  assert.match(src, /firstAudio/);
  assert.match(src, /cap\.msg\.edit/);
  assert.match(src, /!converseSessions.has\(guildId\) && ch && shouldPostLive/);
  const voice = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/voice.js'), 'utf8');
  const convAt = voice.indexOf('if (converse)');
  const rtAt = voice.indexOf('if (realtime)');
  assert.ok(convAt > 0 && convAt < rtAt, 'converse must win over realtime');
});

test("greet force_message only after session.updated and listening", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "../connectors/types/discord/index.js"), "utf8");
  assert.match(src, /armLiveGreet/);
  assert.match(src, /session.updated, listening/);
  assert.match(src, /_wantGreet/);
  assert.match(src, /armLiveGreet\(guildId\)/);
  assert.doesNotMatch(src, /await session\.ready;[\s\S]{0,80}forceMessage/);
  const cg = fs.readFileSync(path.join(__dirname, "../shared/speech/converse-grok.js"), "utf8");
  assert.match(cg, /onSession/);
});

test("1:1 first utterance after greet forces response.create", () => {
  const fs = require("fs");
  const src = fs.readFileSync(require("path").join(__dirname, "../connectors/types/discord/index.js"), "utf8");
  assert.match(src, /_awaitFirstUser/);
  assert.match(src, /first-utterance after greet/);
  assert.match(src, /Unmute uplink now/);
});
