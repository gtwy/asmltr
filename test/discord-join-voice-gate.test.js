'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { joinVoiceAllowed, JOIN_VOICE_OFF_MSG } = require('../connectors/types/discord/join-voice-gate');

test('join-voice is fully off for everyone until rebuilt', () => {
  const prev = process.env.ASMLTR_DISCORD_JOIN_VOICE;
  try {
    delete process.env.ASMLTR_DISCORD_JOIN_VOICE;
    assert.equal(joinVoiceAllowed(), false);
    process.env.ASMLTR_DISCORD_JOIN_VOICE = '1';
    assert.equal(joinVoiceAllowed(), true);
  } finally {
    if (prev == null) delete process.env.ASMLTR_DISCORD_JOIN_VOICE;
    else process.env.ASMLTR_DISCORD_JOIN_VOICE = prev;
  }
  assert.match(JOIN_VOICE_OFF_MSG, /off until it is rebuilt/i);
});

test('discord connector and voice tools honor the join-voice gate', () => {
  const discord = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  assert.match(discord, /join-voice-gate/);
  assert.match(discord, /joinVoiceAllowed/);
  const vt = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/voice-tools.js'), 'utf8');
  assert.match(vt, /join-voice-gate/);
  assert.match(vt, /joinVoiceAllowed/);
  const live = fs.readFileSync(path.join(__dirname, '../shared/speech/live-tools.js'), 'utf8');
  assert.match(live, /join-voice-gate|joinVoiceAllowed/);
});
