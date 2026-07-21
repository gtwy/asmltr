'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const telegram = require('../connectors/types/telegram/index.js');

test('isFatalPollingError is exported', () => {
  assert.equal(typeof telegram.isFatalPollingError, 'function');
});

test('EFATAL is fatal (loop stopped, needs a respawn)', () => {
  assert.equal(telegram.isFatalPollingError({ code: 'EFATAL' }), true);
});

test('ETELEGRAM is recoverable (keep polling)', () => {
  assert.equal(telegram.isFatalPollingError({ code: 'ETELEGRAM' }), false);
});

test('a message-only error is not fatal', () => {
  assert.equal(telegram.isFatalPollingError({ message: 'x' }), false);
});

test('null is not fatal', () => {
  assert.equal(telegram.isFatalPollingError(null), false);
});
