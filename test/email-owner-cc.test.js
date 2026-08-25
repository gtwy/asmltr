'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseAddrList,
  applyOwnerCc,
  selfInTo,
  selfInCcOnly,
  createOutboundGate,
  queueOutboundMail,
} = require('../connectors/types/email');

test('parseAddrList extracts and lowercases from strings, arrays, and Name <addr> form', () => {
  assert.deepEqual(parseAddrList('James <owner@example.com>'), ['owner@example.com']);
  assert.deepEqual(
    parseAddrList(['dritter@xycomgroup.com', 'James <owner@example.com>, dritter@xycomgroup.com']),
    ['dritter@xycomgroup.com', 'owner@example.com'],
  );
});

test('selfInTo / selfInCcOnly: spoken-to vs listen-on-the-chain', () => {
  const toIvy = {
    to: { value: [{ address: 'assistant@example.com' }] },
    cc: { value: [] },
  };
  assert.equal(selfInTo(toIvy, 'assistant@example.com'), true);
  assert.equal(selfInCcOnly(toIvy, 'assistant@example.com'), false);

  const ccIvy = {
    to: { value: [{ address: 'owner@example.com' }] },
    cc: { value: [{ address: 'assistant@example.com' }] },
  };
  assert.equal(selfInTo(ccIvy, 'assistant@example.com'), false);
  assert.equal(selfInCcOnly(ccIvy, 'assistant@example.com'), true);
});

test('applyOwnerCc adds owner as Cc when To is someone else', () => {
  const p = applyOwnerCc({ to: 'dritter@xycomgroup.com', text: 'letter' }, 'owner@example.com');
  assert.equal(p.skip, false);
  assert.equal(p.payload.to, 'dritter@xycomgroup.com');
  assert.equal(p.payload.cc, 'owner@example.com');
});

test('applyOwnerCc does not Cc owner when they are already To', () => {
  const p = applyOwnerCc({ to: 'owner@example.com', text: 'letter' }, 'owner@example.com');
  assert.equal(p.payload.to, 'owner@example.com');
  assert.equal(p.payload.cc, undefined);
});

test('createOutboundGate prepare is owner-Cc only — same body still sends (no 30-min skip)', () => {
  const g = createOutboundGate({ ownerAddr: 'owner@example.com' });
  const first = g.prepare({ to: 'dritter@xycomgroup.com', text: 'same letter' });
  const second = g.prepare({ to: 'owner@example.com', text: 'same letter' });
  assert.equal(first.skip, false);
  assert.equal(second.skip, false);
  assert.equal(second.payload.to, 'owner@example.com');
});

test('queueOutboundMail still returns before sendMail finishes', async () => {
  const g = createOutboundGate({ ownerAddr: 'owner@example.com' });
  let finished = false;
  const sendMail = () => new Promise((resolve) => setTimeout(() => { finished = true; resolve({}); }, 40));
  const q = queueOutboundMail(sendMail, { to: 'dritter@xycomgroup.com', text: 'letter' }, () => {}, (pl) => g.prepare(pl));
  assert.equal(q.queued, true);
  assert.equal(finished, false);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(finished, true);
});
