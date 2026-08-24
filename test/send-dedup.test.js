'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { fingerprint, check, record, formatAlready } = require('../shared/send-dedup');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-send-dedup-')), 'send-recent.json');
}

const mail = {
  channel: 'email',
  target: 'owner@example.com',
  kind: 'text',
  subject: 'zone redirect (waiting on API token)',
  text: 'first body',
};

test('fingerprint is email+to+subject, case-insensitive, ignores body', () => {
  const a = fingerprint(mail);
  const b = fingerprint({ ...mail, target: 'Owner@Example.com', text: 'different body' });
  const c = fingerprint({ ...mail, subject: mail.subject.toUpperCase() });
  assert.equal(a, b);
  assert.equal(a, c);
  assert.match(a, /^email\|owner@example\.com\|subj:/);
});

test('no subject falls back to body hash so different mails still send', () => {
  const a = fingerprint({ channel: 'email', target: 'a@b.c', text: 'one' });
  const b = fingerprint({ channel: 'email', target: 'a@b.c', text: 'two' });
  assert.notEqual(a, b);
  assert.match(a, /\|body:/);
});

test('discord and empty targets are not fingerprinted', () => {
  assert.equal(fingerprint({ channel: 'discord', target: '123', text: 'hi' }), null);
  assert.equal(fingerprint({ channel: 'email', target: '', subject: 'x' }), null);
});

test('second identical email inside the window is already_sent', () => {
  const file = tmpFile();
  const now = 1_000_000;
  assert.equal(check(mail, { file, now }), null);
  record(mail, { via: 'email:ivy-email' }, { file, now });
  const hit = check(mail, { file, now: now + 60_000 });
  assert.equal(hit.ok, true);
  assert.equal(hit.already_sent, true);
  assert.equal(hit.skipped, true);
  assert.equal(hit.via, 'email:ivy-email');
  assert.ok(formatAlready(mail, hit).includes('not resent'));
});

test('force and a new subject both bypass', () => {
  const file = tmpFile();
  const now = 2_000_000;
  record(mail, {}, { file, now });
  assert.equal(check({ ...mail, force: true }, { file, now: now + 1000 }), null);
  assert.equal(check({ ...mail, subject: 'something else' }, { file, now: now + 1000 }), null);
});

test('entries older than the window are ignored', () => {
  const file = tmpFile();
  const now = 3_000_000;
  record(mail, {}, { file, now, windowMs: 60_000 });
  assert.equal(check(mail, { file, now: now + 120_000, windowMs: 60_000 }), null);
});
