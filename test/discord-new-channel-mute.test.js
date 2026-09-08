'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { schemaChannelsDefault, resolveChannelsDefault, muteNewChannel } = require('../connectors/types/discord/new-channel-mute');

test('schema default for new installs is muted (allowlist)', () => {
  assert.equal(schemaChannelsDefault(), false);
  assert.equal(resolveChannelsDefault(undefined, undefined), false);
  assert.equal(resolveChannelsDefault(false, undefined), false);
  assert.equal(resolveChannelsDefault(true, undefined), true);
});

test('persisted channelsDefault is unchanged; explicit map entries are not overwritten', () => {
  assert.equal(resolveChannelsDefault(false, true), true);
  assert.equal(resolveChannelsDefault(true, false), false);
  const map = new Map([['old', true]]);
  assert.equal(muteNewChannel(map, 'old'), false);
  assert.equal(map.get('old'), true);
  assert.equal(muteNewChannel(map, 'brand-new'), true);
  assert.equal(map.get('brand-new'), false);
});

test('discord schema default and channelCreate mute new channels', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  assert.match(src, /new-channel-mute/);
  assert.match(src, /muteNewChannel/);
  assert.match(src, /channelCreate/);
  assert.match(src, /channels_default:[\s\S]*default:\s*false/);
});
