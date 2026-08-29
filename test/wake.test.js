'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { addresses, evaluate, wakeTerms, IVY_ALIASES } = require('../shared/speech/wake');

test('IV / iv / ivy address Ivy at word boundary; divine does not', () => {
  assert.equal(addresses('hey IV', 'Ivy'), true);
  assert.equal(addresses('IV, what time is it', 'Ivy'), true);
  assert.equal(addresses('iv', 'Ivy'), true);
  assert.equal(addresses('IV', 'Ivy'), true);
  assert.equal(addresses('hey ivy', 'Ivy'), true);
  assert.equal(addresses('Ivy, hello', 'Ivy'), true);
  assert.equal(addresses('divine intervention', 'Ivy'), false);
  assert.equal(addresses('skivvy', 'Ivy'), false);
  assert.equal(addresses('revival', 'Ivy'), false);
  assert.deepEqual(wakeTerms('Ivy'), ['ivy', 'iv']);
  assert.ok(IVY_ALIASES.includes('ivy'));
  assert.ok(IVY_ALIASES.includes('iv'));
});

test('aliases only attach when the wake word is Ivy', () => {
  assert.equal(addresses('hey IV', 'Gaia'), false);
  assert.equal(addresses('hey Gaia', 'Gaia'), true);
  assert.deepEqual(wakeTerms('Gaia'), ['gaia']);
});

test('evaluate still fires a clear IV address with extra words', () => {
  const d = evaluate({ text: 'IV, what time is it', wakeWord: 'Ivy' });
  assert.equal(d.addressed, true);
  assert.equal(d.reason, 'ok-clear');
});
