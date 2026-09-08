'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createInboundQueue, formatQueuedPrompt } = require('../connectors/types/discord/inbound-queue');

test('inbound queue is FIFO per channel', () => {
  const q = createInboundQueue();
  q.enqueue('ch1', { text: 'first', author: 'A' });
  q.enqueue('ch1', { text: 'second', author: 'B' });
  q.enqueue('ch2', { text: 'other', author: 'C' });
  assert.equal(q.size('ch1'), 2);
  assert.deepEqual(q.drain('ch1').map((x) => x.text), ['first', 'second']);
  assert.equal(q.size('ch1'), 0);
  assert.deepEqual(q.drain('ch2').map((x) => x.text), ['other']);
});

test('formatQueuedPrompt asks the model to reply only if still needed', () => {
  assert.equal(formatQueuedPrompt([]), '');
  assert.equal(formatQueuedPrompt([{ text: 'just this', author: 'A' }]), 'just this');
  const body = formatQueuedPrompt([
    { text: 'one', author: 'A' },
    { text: 'two', author: 'B' },
  ]);
  assert.match(body, /QUEUED MESSAGES/);
  assert.match(body, /still needed/);
  assert.match(body, /1\/2 A]: one/);
  assert.match(body, /2\/2 B]: two/);
});
