'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-ivy-stream-'));
const allowFile = path.join(tmp, 'tool-policy.json');
fs.writeFileSync(allowFile, JSON.stringify({
  siloAllow: { guilds: ['999000111222333004'], channels: [], denyChannels: ['skip-me'] },
}));
process.env.ASMLTR_TOOL_POLICY_FILE = allowFile;

const { shouldAttachIvyStream } = require('../shared/ivy-stream-attach');
const { buildToolbeltPrompt } = require('../shared/toolbelt-prompt');

test('V32: ivy stream is owner private + silo-allowlisted Discord', () => {
  const owner = { bypass_moderation: true };
  const other = { bypass_moderation: false };
  const kek = { channel: 'discord', public: true, context: { scope_id: 'guild:999000111222333004' }, channel_context: { channelId: 'delicacies' } };
  const skip = { channel: 'discord', public: true, context: { scope_id: 'guild:999000111222333004' }, channel_context: { channelId: 'skip-me' } };
  const otherGuild = { channel: 'discord', public: true, context: { scope_id: 'guild:other' }, channel_context: { channelId: 'ch1' } };

  assert.equal(shouldAttachIvyStream({ channel: 'cli', public: false }, owner), true);
  assert.equal(shouldAttachIvyStream({ channel: 'discord', public: false }, owner), true);
  assert.equal(shouldAttachIvyStream(kek, other), true);
  assert.equal(shouldAttachIvyStream(kek, owner), true);
  assert.equal(shouldAttachIvyStream(skip, other), false);
  assert.equal(shouldAttachIvyStream(otherGuild, other), false);
  assert.equal(shouldAttachIvyStream(otherGuild, owner), false);
  assert.equal(shouldAttachIvyStream({ channel: 'email' }, owner), false);
  assert.equal(shouldAttachIvyStream({ channel: 'github' }, owner), false);
  assert.equal(shouldAttachIvyStream({ channel: 'schedule' }, owner), false);
  assert.equal(shouldAttachIvyStream({ channel: 'cli' }, other), false);
});

test('V32 leftover: silo-allowed turns get find; fully denied silo does not', () => {
  const owner = buildToolbeltPrompt({
    deny: {},
    selfSiloDir: '/tmp/self',
    bypassModeration: true,
  });
  assert.match(owner, /asmltr silo find/);
  assert.match(owner, /memory\/transcripts/);

  const kek = buildToolbeltPrompt({
    deny: { shell: true, streams: true, send: true, silo: false, siloWrite: true },
    selfSiloDir: '/tmp/self',
    bypassModeration: false,
  });
  assert.match(kek, /asmltr silo find/);
  assert.match(kek, /asmltr_silo_find/);
  assert.ok(kek.includes('SELF SILO'));

  const locked = buildToolbeltPrompt({
    deny: { shell: true, streams: true, send: true, silo: true },
    selfSiloDir: '/tmp/self',
  });
  assert.equal(locked.includes('asmltr silo find'), false);
  assert.equal(locked.includes('SELF SILO'), false);
});
