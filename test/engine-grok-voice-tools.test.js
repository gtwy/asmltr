'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const grok = require('../core/src/engines/grok');

test('voice denyAll empties grok tools (no web_search)', () => {
  const args = grok.buildArgs({ prompt: 'can you hear me', denyAll: true, channel: 'discord', conversationKey: 'discord-voice:ivy:guild:1' });
  assert.ok(args.includes('--tools'));
  assert.equal(args[args.indexOf('--tools') + 1], '_none');
  assert.ok(args.includes('--disable-web-search'));
  assert.ok(args.includes('--no-subagents'));
  const i = args.indexOf('--disallowed-tools');
  assert.ok(i >= 0);
  assert.match(args[i + 1], /web_search/);
  assert.equal(args[args.indexOf('--effort') + 1], 'low');
});

test('discord text buildArgs does not empty tools', () => {
  const args = grok.buildArgs({ prompt: 'ok thanks', channel: 'discord' });
  assert.equal(args.includes('--tools'), false);
  assert.equal(args.includes('--disable-web-search'), false);
});
