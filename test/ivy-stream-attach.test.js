'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shouldAttachIvyStream } = require('../shared/ivy-stream-attach');
const { buildToolbeltPrompt } = require('../shared/toolbelt-prompt');

test('V32: ivy stream is owner private surfaces only', () => {
  const owner = { bypass_moderation: true };
  const other = { bypass_moderation: false };
  assert.equal(shouldAttachIvyStream({ channel: 'cli', public: false }, owner), true);
  assert.equal(shouldAttachIvyStream({ channel: 'discord', public: false }, owner), true);
  assert.equal(shouldAttachIvyStream({ channel: 'discord', public: true }, owner), false);
  assert.equal(shouldAttachIvyStream({ channel: 'email' }, owner), false);
  assert.equal(shouldAttachIvyStream({ channel: 'github' }, owner), false);
  assert.equal(shouldAttachIvyStream({ channel: 'schedule' }, owner), false);
  assert.equal(shouldAttachIvyStream({ channel: 'discord', public: false }, other), false);
  assert.equal(shouldAttachIvyStream({ channel: 'cli' }, other), false);
  assert.equal(shouldAttachIvyStream({ channel: 'cli' }, null), false);
});

test('V32: silo find is owner-only in the toolbelt prompt', () => {
  const owner = buildToolbeltPrompt({
    deny: {},
    selfSiloDir: '/tmp/self',
    bypassModeration: true,
  });
  assert.match(owner, /asmltr silo find/);
  assert.match(owner, /memory\/transcripts/);

  const mixed = buildToolbeltPrompt({
    deny: { shell: true, streams: true, send: true, silo: false, siloWrite: true },
    selfSiloDir: '/tmp/self',
    bypassModeration: false,
  });
  assert.equal(mixed.includes('asmltr silo find'), false);
  assert.equal(mixed.includes('asmltr_silo_find'), false);
  assert.equal(mixed.includes('memory/transcripts'), false);
  assert.ok(mixed.includes('SELF SILO'));
});
