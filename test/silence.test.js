'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isNoReplySentinel } = require('../shared/silence');

test('exact token is silence', () => {
  assert.equal(isNoReplySentinel('[[NO_REPLY]]'), true);
  assert.equal(isNoReplySentinel('  [[NO_REPLY]]  \n'), true);
  assert.equal(isNoReplySentinel('[[no_reply]]'), true);
});

test('last non-empty line is silence (redirect)', () => {
  assert.equal(isNoReplySentinel('Posted on GitHub.\n\n[[NO_REPLY]]'), true);
  assert.equal(isNoReplySentinel('[[NO_REPLY]]\n'), true);
});

test('mention inside a real reply is not silence', () => {
  const body = 'A `[[NO_REPLY]]` / suppressed turn no longer gets recorded as a delivered turn.\n\nI left a note on the PR for her.';
  assert.equal(isNoReplySentinel(body), false);
  assert.equal(isNoReplySentinel('Thanks, [[NO_REPLY]]'), false);
  assert.equal(isNoReplySentinel('see [[NO_REPLY]] in core'), false);
});

test('empty is not the sentinel (empty-no-reply is a different path)', () => {
  assert.equal(isNoReplySentinel(''), false);
  assert.equal(isNoReplySentinel(null), false);
  assert.equal(isNoReplySentinel('hello'), false);
});

test('stripNoReplySentinel leaves a letter, empties token-only', () => {
  const { stripNoReplySentinel } = require('../shared/silence');
  assert.equal(stripNoReplySentinel('Hi\n\n[[NO_REPLY]]'), 'Hi');
  assert.equal(stripNoReplySentinel('[[NO_REPLY]]'), '');
  assert.equal(stripNoReplySentinel('plain letter'), 'plain letter');
});

test('email keeps a letter tagged with last-line sentinel; other channels do not', () => {
  const { emailKeepLetterDespiteSentinel } = require('../shared/silence');
  const letter = 'James,\n\nYes. Hot-swappable.\n\n[[NO_REPLY]]';
  assert.equal(emailKeepLetterDespiteSentinel('email', letter), 'James,\n\nYes. Hot-swappable.');
  assert.equal(emailKeepLetterDespiteSentinel('email', '[[NO_REPLY]]'), null);
  assert.equal(emailKeepLetterDespiteSentinel('discord', letter), null);
  assert.equal(emailKeepLetterDespiteSentinel('email', 'plain letter'), null);
});
