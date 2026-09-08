'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  wantsHandoff, stripHandoffSentinel, refuseInChannelText, handoffEnvelope, HANDOFF_SENTINEL,
} = require('../connectors/types/discord/owner-public-handoff');

test('handoff sentinel is stripped from the public reply', () => {
  assert.equal(wantsHandoff(`Sorry.\n${HANDOFF_SENTINEL}`), true);
  assert.equal(wantsHandoff('just chatting'), false);
  assert.equal(stripHandoffSentinel(`I can't do that here.\n${HANDOFF_SENTINEL}`), "I can't do that here.");
});

test('handoff envelope is a private owner DM, no public channel key', () => {
  const env = handoffEnvelope({
    instanceId: 'bot',
    ownerId: '111',
    question: 'open a shell on the box',
    contextText: 'they asked in #general',
    channelName: 'general',
    requesterName: 'owner',
  });
  assert.equal(env.channel, 'discord');
  assert.equal(env.public, false);
  assert.equal(env.conversation_key, 'discord:bot:dm:111');
  assert.equal(env.context.scope_id, 'dm:111');
  assert.match(env.content.text, /HANDOFF/);
  assert.match(env.content.text, /open a shell/);
  assert.doesNotMatch(env.content.text, /@/);
  assert.equal(refuseInChannelText().includes('DM'), true);
});
