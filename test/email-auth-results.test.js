'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseAuthResults, authDisposition, formatAuthSummary, authRejected,
} = require('../connectors/types/email/index.js');

const rejectLog = path.join(os.tmpdir(), 'asmltr-email-auth-reject-test.jsonl');
process.env.ASMLTR_EMAIL_AUTH_REJECT_LOG = rejectLog;

after(() => {
  delete process.env.ASMLTR_OWNER_FROM_EMAIL;
  delete process.env.ASMLTR_EMAIL_AUTH_REJECT_LOG;
  try { fs.unlinkSync(rejectLog); } catch (_) {}
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
  'dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=example.com';

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

test('authDisposition pass only when DKIM and SPF and DMARC are pass', () => {
  const a = authDisposition(parsedWith(GMAIL_PASS));
  assert.equal(a.present, true);
  assert.equal(a.passed, true);
  assert.equal(a.failed, false);
  assert.equal(authRejected(a), false);
});

test('authDisposition fail when any of the three is fail', () => {
  const a = authDisposition(parsedWith(GMAIL_FAIL));
  assert.equal(a.present, true);
  assert.equal(a.passed, false);
  assert.equal(a.failed, true);
  assert.equal(authRejected(a), true);
});

test('authDisposition missing header is a fail', () => {
  const a = authDisposition({ headers: { get() { return undefined; } } });
  assert.equal(a.present, false);
  assert.equal(a.failed, true);
  assert.equal(a.passed, false);
  assert.equal(authRejected(a), true);
  assert.match(a.reason, /no Authentication-Results header/);
});

test('dmarc pass does not excuse a dkim or spf miss', () => {
  const a = authDisposition(parsedWith('mx.example; spf=fail; dkim=fail; dmarc=pass'));
  assert.equal(a.passed, false);
  assert.equal(a.failed, true);
  assert.match(a.reason, /DKIM=fail/);
  assert.match(a.reason, /SPF=fail/);
});

test('spf pass and dkim pass without dmarc is a fail', () => {
  const a = authDisposition(parsedWith('mx.example; dkim=pass; spf=pass'));
  assert.equal(a.failed, true);
  assert.match(a.reason, /DMARC=missing/);
});

test('softfail SPF is not a pass', () => {
  const a = authDisposition(parsedWith('mx.example; dkim=pass; spf=softfail; dmarc=pass'));
  assert.equal(a.failed, true);
  assert.match(a.reason, /SPF=softfail/);
});

test('authRejected is everyone, not owner-only', () => {
  const fail = authDisposition(parsedWith(GMAIL_FAIL));
  const pass = authDisposition(parsedWith(GMAIL_PASS));
  assert.equal(authRejected(fail), true);
  assert.equal(authRejected(pass), false);
  assert.equal(authRejected(null), true);
});

test('formatAuthSummary', () => {
  assert.match(formatAuthSummary(authDisposition(parsedWith(GMAIL_PASS))), /DKIM=pass SPF=pass DMARC=pass — PASS/);
  assert.match(formatAuthSummary(authDisposition({ headers: { get() {} } })), /none \(treated as fail\)/);
});
