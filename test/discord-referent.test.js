'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  ASK_MISSING_MEDIA, referentPromptBlock, shouldQueueLateMedia, isReplyToUs,
} = require('../connectors/types/discord/referent');

test('ask text is the operator wording', () => {
  assert.match(ASK_MISSING_MEDIA, /forget to attach the media/i);
  assert.match(referentPromptBlock(), /AFTER that question/);
  assert.match(referentPromptBlock(), /only when they point at earlier context/);
  assert.match(referentPromptBlock(), /Do not stall/);
});

test('queue late media only for the turn starter with attachments', () => {
  const slot = { starterId: '111' };
  assert.equal(shouldQueueLateMedia(slot, { author: { id: '111' }, attachments: { size: 1 } }), true);
  assert.equal(shouldQueueLateMedia(slot, { author: { id: '222' }, attachments: { size: 1 } }), false);
  assert.equal(shouldQueueLateMedia(slot, { author: { id: '111' }, attachments: { size: 0 } }), false);
  assert.equal(shouldQueueLateMedia(null, { author: { id: '111' }, attachments: { size: 1 } }), false);
});

test('reply to us is structural (repliedUser), not a phrase list', () => {
  assert.equal(isReplyToUs({ mentions: { repliedUser: { id: 'bot' } } }, 'bot'), true);
  assert.equal(isReplyToUs({ mentions: { repliedUser: { id: 'other' } } }, 'bot'), false);
  assert.equal(isReplyToUs({ mentions: {} }, 'bot'), false);
});

test('discord connector wires referent, late-media save, no look-ahead complete()', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  assert.match(src, /referentPromptBlock/);
  assert.match(src, /shouldQueueLateMedia/);
  assert.match(src, /isReplyToUs/);
  assert.match(src, /lateMedia/);
  assert.equal(src.includes('complete('), false);
});
