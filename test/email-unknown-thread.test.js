'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  headerHasThread,
  selfIsRecipient,
  senderOnPriorThread,
  shouldOwnerForwardUnknown,
  emailsFromContactsDoc,
  persistThreads,
  readThreads,
} = require('../connectors/types/email');

const ivy = 'assistant@example.com';
const angela = 'angela@rhinoministoragepa.com';

function parsed({ from, to, cc, inReplyTo, references }) {
  const field = (addrs) => ({ value: (addrs || []).map((address) => ({ address })) });
  return {
    from: field(from),
    to: field(to),
    cc: field(cc),
    inReplyTo: inReplyTo || null,
    references: references || [],
  };
}

test('headerHasThread is true for In-Reply-To or References', () => {
  assert.equal(headerHasThread(parsed({})), false);
  assert.equal(headerHasThread(parsed({ inReplyTo: '<mid>' })), true);
  assert.equal(headerHasThread(parsed({ references: ['<mid>'] })), true);
  assert.equal(headerHasThread(parsed({ references: '  <mid>  ' })), true);
});

test('selfIsRecipient is To or Cc', () => {
  assert.equal(selfIsRecipient(parsed({ to: [ivy] }), ivy), true);
  assert.equal(selfIsRecipient(parsed({ to: ['owner@example.com'], cc: [ivy] }), ivy), true);
  assert.equal(selfIsRecipient(parsed({ to: ['owner@example.com'] }), ivy), false);
});

test('senderOnPriorThread matches from/to/cc of the stored thread', () => {
  const prior = { from: [angela], to: [ivy, 'owner@example.com'], cc: [] };
  assert.equal(senderOnPriorThread(prior, angela), true);
  assert.equal(senderOnPriorThread(prior, ivy), true);
  assert.equal(senderOnPriorThread(prior, 'stranger@example.com'), false);
  assert.equal(senderOnPriorThread(null, angela), false);
});

test('cold unknown still owner-forwards', () => {
  const p = parsed({ from: ['stranger@example.com'], to: [ivy] });
  assert.equal(shouldOwnerForwardUnknown({
    known: false, parsed: p, selfAddr: ivy, fromAddr: 'stranger@example.com',
  }), true);
});

test('Access-card known does not owner-forward', () => {
  const p = parsed({ from: [angela], to: [ivy] });
  assert.equal(shouldOwnerForwardUnknown({
    known: true, parsed: p, selfAddr: ivy, fromAddr: angela,
  }), false);
});

test('Rolodex/contacts hit does not owner-forward', () => {
  const p = parsed({ from: [angela], to: [ivy] });
  assert.equal(shouldOwnerForwardUnknown({
    known: false, contactsKnown: true, parsed: p, selfAddr: ivy, fromAddr: angela,
  }), false);
});

test('reply on a chain we are on does not owner-forward (Angela case)', () => {
  const p = parsed({
    from: [angela],
    to: [ivy, 'owner@example.com'],
    inReplyTo: '<ivy-earlier-mid>',
  });
  assert.equal(shouldOwnerForwardUnknown({
    known: false, parsed: p, selfAddr: ivy, fromAddr: angela,
  }), false);
});

test('prior thread participant does not owner-forward even without In-Reply-To', () => {
  const p = parsed({ from: [angela], to: [ivy] });
  assert.equal(shouldOwnerForwardUnknown({
    known: false, parsed: p, selfAddr: ivy, fromAddr: angela,
    priorThread: { from: ['owner@example.com'], to: [ivy, angela], cc: [] },
  }), false);
});

test('emailsFromContactsDoc collects otherContacts too', () => {
  const set = emailsFromContactsDoc({
    results: [
      { emails: ['angela@chernegaconstruction.com'] },
      { emails: ['angela@rhinoministoragepa.com'], source: 'other' },
    ],
  });
  assert.equal(set.has('angela@rhinoministoragepa.com'), true);
  assert.equal(set.has('angela@chernegaconstruction.com'), true);
});

test('persistThreads round-trips participants', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-threads-'));
  const prev = process.env.ASMLTR_EMAIL_THREADS_FILE;
  process.env.ASMLTR_EMAIL_THREADS_FILE = path.join(dir, 'threads.json');
  try {
    const map = new Map([['email:x:thread:abc', { from: [angela], to: [ivy], cc: [] }]]);
    persistThreads('x', map);
    const loaded = readThreads('x');
    assert.deepEqual(loaded.get('email:x:thread:abc').from, [angela]);
  } finally {
    if (prev == null) delete process.env.ASMLTR_EMAIL_THREADS_FILE;
    else process.env.ASMLTR_EMAIL_THREADS_FILE = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
