'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { shouldPlayWakeChime } = require('../connectors/types/discord/wake-chime');

test('no chime on follow-up / already-listening; first join still chimes', () => {
  assert.equal(shouldPlayWakeChime({ listening: true, connected: true }), false);
  assert.equal(shouldPlayWakeChime({ listening: true, connected: false }), false);
  assert.equal(shouldPlayWakeChime({ listening: false, connected: true }), false);
  assert.equal(shouldPlayWakeChime({ listening: false, connected: false }), true);
  assert.equal(shouldPlayWakeChime({}), true);

  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  assert.match(src, /shouldPlayWakeChime/);
  assert.match(src, /voice\.isListening\(guildId\)/);
  assert.match(src, /voice\.isConnected\(guildId\)/);
  const join = src.slice(src.indexOf('async function doJoinVoice'), src.indexOf('async function doLeaveVoice'));
  assert.equal(/shouldPlayWakeChime/.test(join), false);
  assert.match(src, /voice\.playChime\(guildId\)/);
});
