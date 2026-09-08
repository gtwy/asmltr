'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { channelAcpPrompt, thoughtChipsEnabledForGuild } = require('../connectors/types/discord/channel-acp-prompt');

test('guild ACP prompt has no thought chips and locks medium effort', () => {
  const p = channelAcpPrompt({ awake: true, caretLookup: true, isOwner: true });
  assert.match(p, /CHANNEL SESSION \(ACP\)/);
  assert.match(p, /medium/);
  assert.match(p, /Never post thought chips/);
  assert.match(p, /discord search/);
  assert.match(p, /guild-post/);
  assert.match(p, /shell/);
  assert.match(p, /HANDOFF/);
  assert.match(p, /CARET LOOKUP/);
  assert.doesNotMatch(p, /@/);
  assert.equal(thoughtChipsEnabledForGuild(), false);
});

test('non-owner prompt omits the handoff line', () => {
  const p = channelAcpPrompt({ awake: true, isOwner: false, caretLookup: false });
  assert.doesNotMatch(p, /HANDOFF/);
  assert.doesNotMatch(p, /CARET LOOKUP/);
});
