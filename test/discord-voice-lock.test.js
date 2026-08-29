'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const discord = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '../core/src/server.js'), 'utf8');
const grok = fs.readFileSync(path.join(__dirname, '../core/src/engines/grok.js'), 'utf8');
const mod = fs.readFileSync(path.join(__dirname, '../core/src/moderation.js'), 'utf8');

test('no follow-up chime when already listening; join-once chime stays', () => {
  assert.match(discord, /shouldPlayWakeChime/);
  assert.match(discord, /voice\.isListening\(guildId\)/);
  assert.match(discord, /voice\.isConnected\(guildId\)/);
  const join = discord.slice(discord.indexOf('async function doJoinVoice'), discord.indexOf('async function doLeaveVoice'));
  assert.match(join, /voice\.playChime\(message\.guild\.id\)/);
  assert.equal(/shouldPlayWakeChime/.test(join), false);
});

test('voice handleStream skips toolbelt; denyAll empties tools before grok spawn', () => {
  assert.match(discord, /conversation_key: `discord-voice:\$\{ctx\.instanceId\}:guild:\$\{guildId\}`/);
  assert.match(discord, /channel_context: \{ voice: true/);
  assert.match(discord, /Do not use tools/);
  assert.equal(discord.includes('You may use tools if truly needed'), false);
  assert.match(server, /const voiceTurn = isDiscordVoice\(e\)/);
  assert.match(server, /if \(!voiceTurn && process\.env\.ASMLTR_SELF_AWARE/);
  assert.match(server, /denyTools: toolPolicy\.deny/);
  assert.match(grok, /const denyAll = !!opts\.denyAll \|\| isDiscordVoice\(opts\)/);
  assert.match(grok, /args\.push\('--tools', ''\)/);
  assert.match(grok, /args\.push\('--deny', 'MCPTool'\)/);
  assert.match(grok, /if \(!_mcpSynced && !voiceTurn\)/);
});

test('ALL voice turns skip gpt-5-nano / moderation; barge-in stays; no ElevenLabs websocket', () => {
  assert.match(mod, /Spoken Discord turns skip gpt-5-nano/);
  assert.match(mod, /isDiscordVoice\(meta\)/);
  assert.match(mod, /skipped: true/);
  assert.equal(/voice_barge_in\s*=\s*false/.test(discord), false);
  assert.match(discord, /shouldBargeIn/);
  assert.equal(/new WebSocket|wss:\/\/api\.elevenlabs|eleven_labs_ws|ElevenLabs websocket/i.test(discord), false);
  assert.equal(/new WebSocket|wss:\/\/api\.elevenlabs/i.test(grok), false);
});

test('join-voice / voice_join stay owner-only', () => {
  assert.match(discord, /OWNER_ONLY_CMDS/);
  const ownerBlock = discord.slice(discord.indexOf('const OWNER_ONLY_CMDS'), discord.indexOf('const meta'));
  assert.match(ownerBlock, /join-voice/);
  assert.match(discord, /if \(OWNER_ONLY_CMDS\.has\(cmd\) && !\(await isOwner\(message\)\)\)/);
  const voiceAt = discord.indexOf("app.post('/voice'");
  assert.ok(voiceAt >= 0);
  const voiceHttp = discord.slice(voiceAt, voiceAt + 900);
  assert.match(voiceHttp, /voice_join/);
  assert.match(voiceHttp, /if \(!\(await isOwner\(fake\)\)\)/);
});
