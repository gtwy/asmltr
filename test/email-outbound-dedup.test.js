'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseAddrList,
  outboundBodyKey,
  replyAllRecipients,
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

test('outboundBodyKey ignores wrapping whitespace', () => {
  assert.equal(outboundBodyKey('hello\n\nthere'), outboundBodyKey('  hello there  '));
  assert.notEqual(outboundBodyKey('a'), outboundBodyKey('b'));
});

test('replyAllRecipients: To = From, Cc = other inbound, owner only when writing someone else', () => {
  const parsed = {
    from: { value: [{ address: 'owner@example.com' }] },
    to: { value: [{ address: 'assistant@example.com' }] },
    cc: { value: [] },
  };
  const solo = replyAllRecipients(parsed, 'assistant@example.com', 'owner@example.com');
  assert.deepEqual(solo.to, ['owner@example.com']);
  assert.deepEqual(solo.cc, []);

  const withCust = {
    from: { value: [{ address: 'dritter@xycomgroup.com' }] },
    to: { value: [{ address: 'assistant@example.com' }, { address: 'owner@example.com' }] },
    cc: { value: [] },
  };
  const ra = replyAllRecipients(withCust, 'assistant@example.com', 'owner@example.com');
  assert.deepEqual(ra.to, ['dritter@xycomgroup.com']);
  assert.deepEqual(ra.cc, ['owner@example.com']);

  const noOwnerOnInbound = {
    from: { value: [{ address: 'dritter@xycomgroup.com' }] },
    to: { value: [{ address: 'assistant@example.com' }] },
    cc: { value: [] },
  };
  const auto = replyAllRecipients(noOwnerOnInbound, 'assistant@example.com', 'owner@example.com');
  assert.deepEqual(auto.to, ['dritter@xycomgroup.com']);
  assert.deepEqual(auto.cc, ['owner@example.com']);
});

test('createOutboundGate auto-Ccs owner when To is someone else', () => {
  const g = createOutboundGate({ ownerAddr: 'owner@example.com' });
  const p = g.prepare({ to: 'dritter@xycomgroup.com', text: 'letter' });
  assert.equal(p.skip, false);
  assert.equal(p.payload.to, 'dritter@xycomgroup.com');
  assert.equal(p.payload.cc, 'owner@example.com');
});

test('createOutboundGate does not auto-Cc owner when they are already To', () => {
  const g = createOutboundGate({ ownerAddr: 'owner@example.com' });
  const p = g.prepare({ to: 'owner@example.com', text: 'letter' });
  assert.equal(p.payload.to, 'owner@example.com');
  assert.equal(p.payload.cc, undefined);
});

test('same body: second send drops anyone already copied and skips if none left', () => {
  const g = createOutboundGate({ ownerAddr: 'owner@example.com' });
  const first = g.prepare({ to: 'dritter@xycomgroup.com', cc: 'owner@example.com', text: 'same letter' });
  assert.equal(first.skip, false);
  const second = g.prepare({ to: 'owner@example.com', text: 'same letter' });
  assert.equal(second.skip, true);
  assert.match(second.reason, /already copied/);
  assert.ok(second.skippedAddrs.includes('owner@example.com'));
});

test('same body: a new recipient still sends, overlapping addresses drop', () => {
  const g = createOutboundGate({ ownerAddr: '' });
  g.prepare({ to: 'a@example.com', cc: 'b@example.com', text: 'body' });
  const p = g.prepare({ to: 'b@example.com, c@example.com', text: 'body' });
  assert.equal(p.skip, false);
  assert.equal(p.payload.to, 'c@example.com');
  assert.ok(!String(p.payload.to + ' ' + (p.payload.cc || '')).includes('b@example.com'));
});

test('force sends even when already copied', () => {
  const g = createOutboundGate({ ownerAddr: 'owner@example.com' });
  g.prepare({ to: 'dritter@xycomgroup.com', text: 'letter' });
  const p = g.prepare({ to: 'owner@example.com', text: 'letter' }, { force: true });
  assert.equal(p.skip, false);
  assert.equal(p.payload.to, 'owner@example.com');
});

test('queueOutboundMail prepare records before returning so a later reply sees the copy', async () => {
  const g = createOutboundGate({ ownerAddr: 'owner@example.com' });
  let smtp = 0;
  const sendMail = async () => { smtp += 1; await new Promise((r) => setTimeout(r, 40)); };
  const q = queueOutboundMail(sendMail, { to: 'dritter@xycomgroup.com', text: 'letter' }, () => {}, (pl) => g.prepare(pl));
  assert.equal(q.queued, true);
  const later = g.prepare({ to: 'owner@example.com', text: 'letter' });
  assert.equal(later.skip, true);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(smtp, 1);
});
