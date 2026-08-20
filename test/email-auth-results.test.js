'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseAuthResults, authDisposition, formatAuthSummary, ownerAuthRejected,
} = require('../connectors/types/email/index.js');

after(() => {
  delete process.env.ASMLTR_OWNER_FROM_EMAIL;
});

function parsedWith(header) {
  return {
    headers: {
      get(name) {
        if (String(name).toLowerCase() === 'authentication-results') return header;
        return undefined;
      },
    },
  };
}

const GMAIL_PASS = 'mx.google.com; dkim=pass header.i=@example.com header.s=google header.b=abcd; ' +
  'spf=pass (google.com: domain of owner@example.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=owner@example.com; ' +
  'dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com';

const GMAIL_FAIL = 'mx.google.com; dkim=fail header.i=@example.com; spf=fail smtp.mailfrom=owner@example.com; dmarc=fail header.from=example.com';

test('parseAuthResults reads dkim/spf/dmarc first token', () => {
  const r = parseAuthResults(GMAIL_PASS);
  assert.equal(r.dkim, 'pass');
  assert.equal(r.spf, 'pass');
  assert.equal(r.dmarc, 'pass');
});

test('parseAuthResults empty header is all null', () => {
  assert.deepEqual(parseAuthResults(''), { dkim: null, spf: null, dmarc: null });
  assert.deepEqual(parseAuthResults(null), { dkim: null, spf: null, dmarc: null });
});

test('authDisposition pass when dmarc=pass', () => {
  const a = authDisposition(parsedWith(GMAIL_PASS));
  assert.equal(a.present, true);
  assert.equal(a.passed, true);
  assert.equal(a.failed, false);
});

test('authDisposition fail when dmarc=fail', () => {
  const a = authDisposition(parsedWith(GMAIL_FAIL));
  assert.equal(a.present, true);
  assert.equal(a.passed, false);
  assert.equal(a.failed, true);
});

test('authDisposition missing header is not a fail (do not lock out)', () => {
  const a = authDisposition({ headers: { get() { return undefined; } } });
  assert.equal(a.present, false);
  assert.equal(a.failed, false);
  assert.equal(a.passed, false);
});

test('dmarc pass wins over a sibling fail', () => {
  const a = authDisposition(parsedWith('mx.example; spf=fail; dkim=fail; dmarc=pass'));
  assert.equal(a.passed, true);
  assert.equal(a.failed, false);
});

test('ownerAuthRejected only when From is owner AND auth failed', () => {
  process.env.ASMLTR_OWNER_FROM_EMAIL = 'owner@example.com';
  const fail = authDisposition(parsedWith(GMAIL_FAIL));
  const pass = authDisposition(parsedWith(GMAIL_PASS));
  const missing = authDisposition({ headers: { get() { return undefined; } } });
  assert.equal(ownerAuthRejected('owner@example.com', fail), true);
  assert.equal(ownerAuthRejected('Owner@Example.com', fail), true);
  assert.equal(ownerAuthRejected('other@example.com', fail), false);
  assert.equal(ownerAuthRejected('owner@example.com', pass), false);
  assert.equal(ownerAuthRejected('owner@example.com', missing), false);
});

test('ownerAuthRejected is off when ASMLTR_OWNER_FROM_EMAIL is unset', () => {
  delete process.env.ASMLTR_OWNER_FROM_EMAIL;
  const fail = authDisposition(parsedWith(GMAIL_FAIL));
  assert.equal(ownerAuthRejected('owner@example.com', fail), false);
});

test('formatAuthSummary', () => {
  assert.match(formatAuthSummary(authDisposition(parsedWith(GMAIL_PASS))), /DKIM=pass SPF=pass DMARC=pass/);
  assert.match(formatAuthSummary(authDisposition({ headers: { get() {} } })), /none on this message/);
});
