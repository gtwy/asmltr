'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { addresses, evaluate, wakeTerms, STT_ALIASES } = require('../shared/speech/wake');

test('gaia addresses at word boundary; divine/revival do not', () => {
  assert.equal(addresses('hey Gaia', 'Gaia'), true);
  assert.equal(addresses('Gaia, hello', 'Gaia'), true);
  assert.equal(addresses('gaia', 'Gaia'), true);
  assert.equal(addresses('divine intervention', 'Gaia'), false);
  assert.equal(addresses('skivvy', 'Gaia'), false);
  assert.equal(addresses('revival', 'Gaia'), false);
  assert.deepEqual(wakeTerms('Gaia'), ['gaia']);
  assert.deepEqual(STT_ALIASES, {});
});

test('aliases do not attach for Gaia (public product has no STT extras)', () => {
  assert.equal(addresses('hey IV', 'Gaia'), false);
  assert.equal(addresses('hey Gaia', 'Gaia'), true);
  assert.deepEqual(wakeTerms('Gaia'), ['gaia']);
});

test('evaluate still fires a clear Gaia address with extra words', () => {
  const d = evaluate({ text: 'Gaia, what time is it', wakeWord: 'Gaia' });
  assert.equal(d.addressed, true);
  assert.equal(d.reason, 'ok-clear');
});
