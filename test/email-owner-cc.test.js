'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseAddrList,
  applyOwnerCc,
  mergeReplyAll,
  selfInTo,
  selfInCcOnly,
  createOutboundGate,
  queueOutboundMail,
} = require('../connectors/types/email');

test('parseAddrList extracts and lowercases from strings, arrays, and Name <addr> form', () => {
  assert.deepEqual(parseAddrList('James <owner@example.com>'), ['owner@example.com']);
  assert.deepEqual(
    parseAddrList(['other@example.com', 'James <owner@example.com>, other@example.com']),
    ['other@example.com', 'owner@example.com'],
  );
});

test('selfInTo / selfInCcOnly: spoken-to vs listen-on-the-chain', () => {
  const toSelf = {
    to: { value: [{ address: 'assistant@example.com' }] },
    cc: { value: [] },
  };
  assert.equal(selfInTo(toSelf, 'assistant@example.com'), true);
  assert.equal(selfInCcOnly(toSelf, 'assistant@example.com'), false);

  const ccSelf = {
    to: { value: [{ address: 'owner@example.com' }] },
    cc: { value: [{ address: 'assistant@example.com' }] },
  };
  assert.equal(selfInTo(ccSelf, 'assistant@example.com'), false);
  assert.equal(selfInCcOnly(ccSelf, 'assistant@example.com'), true);
});

test('applyOwnerCc adds owner as Cc when To is someone else', () => {
  const p = applyOwnerCc({ to: 'other@example.com', text: 'letter' }, 'owner@example.com');
  assert.equal(p.skip, false);
  assert.equal(p.payload.to, 'other@example.com');
  assert.equal(p.payload.cc, 'owner@example.com');
});

test('applyOwnerCc does not Cc owner when they are already To', () => {
  const p = applyOwnerCc({ to: 'owner@example.com', text: 'letter' }, 'owner@example.com');
  assert.equal(p.payload.to, 'owner@example.com');
  assert.equal(p.payload.cc, undefined);
});

test('createOutboundGate prepare is owner-Cc only — same body still sends (no 30-min skip)', () => {
  const g = createOutboundGate({ ownerAddr: 'owner@example.com' });
  const first = g.prepare({ to: 'other@example.com', text: 'same letter' });
  const second = g.prepare({ to: 'owner@example.com', text: 'same letter' });
  assert.equal(first.skip, false);
  assert.equal(second.skip, false);
  assert.equal(second.payload.to, 'owner@example.com');
});

test('queueOutboundMail still returns before sendMail finishes', async () => {
  const g = createOutboundGate({ ownerAddr: 'owner@example.com' });
  let finished = false;
  const sendMail = () => new Promise((resolve) => setTimeout(() => { finished = true; resolve({}); }, 40));
  const q = queueOutboundMail(sendMail, { to: 'other@example.com', text: 'letter' }, () => {}, (pl) => g.prepare(pl));
  assert.equal(q.queued, true);
  assert.equal(finished, false);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(finished, true);
});

test('mergeReplyAll keeps Tim/Joey/James when send targeted only Angela', () => {
  const thread = {
    from: ['angela@example.com'],
    to: ['assistant@example.com', 'owner@example.com', 'tim@example.com'],
    cc: ['joey@example.com'],
  };
  const p = mergeReplyAll(
    { to: 'angela@example.com', text: 'hi' },
    thread,
    'assistant@example.com',
    [],
  );
  const all = (p.to + ' ' + (p.cc || '')).toLowerCase();
  assert.match(p.to, /angela@example.com/);
  assert.match(all, /owner@example.com/);
  assert.match(all, /tim@example.com/);
  assert.match(all, /joey@example.com/);
  assert.equal(all.includes('assistant@example.com'), false);
});

test('mergeReplyAll honors --drop', () => {
  const thread = {
    from: ['angela@example.com'],
    to: ['owner@example.com', 'tim@example.com', 'assistant@example.com'],
    cc: [],
  };
  const p = mergeReplyAll(
    { to: 'angela@example.com', text: 'hi' },
    thread,
    'assistant@example.com',
    'tim@example.com',
  );
  const all = (p.to + ' ' + (p.cc || '')).toLowerCase();
  assert.equal(all.includes('tim@example.com'), false);
  assert.match(all, /owner@example.com/);
});

test('mergeReplyAll drops automated vendors but keeps real Microsoft employees', () => {
  const thread = {
    from: ['microsoft-noreply@microsoft.com'],
    to: ['assistant@example.com', 'owner@example.com'],
    cc: ['alerts@example.com', 'alice@microsoft.com'],
  };
  const p = mergeReplyAll(
    { to: 'owner@example.com, joey@example.com, tim@example.com', text: 'staff' },
    thread,
    'assistant@example.com',
    [],
  );
  const all = (p.to + ' ' + (p.cc || '')).toLowerCase();
  assert.equal(all.includes('microsoft-noreply@microsoft.com'), false);
  assert.equal(all.includes('alerts@example.com'), false);
  assert.match(all, /owner@example.com/);
  assert.match(all, /joey@example.com/);
  assert.match(all, /tim@example.com/);
  assert.match(all, /alice@microsoft.com/);
});

test('mergeReplyAll without a thread leaves the payload To/Cc alone', () => {
  const p = mergeReplyAll(
    { to: 'solo@example.com', cc: 'boss@example.com', text: 'hi' },
    {},
    'assistant@example.com',
    [],
  );
  assert.equal(p.to, 'solo@example.com');
  assert.equal(p.cc, 'boss@example.com');
});
