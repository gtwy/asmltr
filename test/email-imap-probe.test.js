'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Guards the #34 fix for the email connector: the IMAP watcher probes liveness with a time-boxed NOOP
// so a silently-dropped IDLE (half-open TCP, no 'close' event) is detected instead of going deaf. The
// probe RESOLVES when the link answers and REJECTS when it's dead or stalls — the caller heartbeats on
// resolve and forces a reconnect on reject. Dead-handle heal: probe must schedule connectImap when
// !imap || !imap.usable (not a no-op); connection-class fetch errors close() so the close handler
// reconnects; lastUid still advances only on handled.
const {
  imapNoopProbe,
  isImapConnectionError,
  readLastUid,
  persistLastUid,
} = require('../connectors/types/email/index.js');

test('probe resolves when NOOP answers (link alive)', async () => {
  await imapNoopProbe({ noop: async () => ({}) }, 500); // resolves → no throw
});

test('probe rejects when NOOP errors (link dead)', async () => {
  await assert.rejects(() => imapNoopProbe({ noop: async () => { throw new Error('ECONNRESET'); } }, 500));
});

test('probe rejects on a hung NOOP (half-open — the exact silent-death case)', async () => {
  const started = Date.now();
  await assert.rejects(() => imapNoopProbe({ noop: () => new Promise(() => {}) /* never settles */ }, 200), /noop timeout/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 150 && elapsed < 2000, `should time out near 200ms, took ${elapsed}ms`);
});

test('connection-class errors are the ones fetchNew close()s on', () => {
  for (const msg of [
    'Connection not available',
    'not connected',
    'socket hang up',
    'Connection closed',
    'noop timeout',
    'ECONNRESET',
  ]) {
    assert.equal(isImapConnectionError(new Error(msg)), true, msg);
  }
  assert.equal(isImapConnectionError(new Error('parse failed: unexpected token')), false);
  assert.equal(isImapConnectionError(new Error('ENOENT: no such file')), false);
});

test('readLastUid / persistLastUid round-trip; missing file is null', () => {
  const prev = process.env.ASMLTR_EMAIL_LASTUID_FILE;
  const f = path.join(os.tmpdir(), `asmltr-lastuid-test-${process.pid}-${Date.now()}.json`);
  process.env.ASMLTR_EMAIL_LASTUID_FILE = f;
  try {
    assert.equal(readLastUid('unused'), null);
    persistLastUid('unused', 21);
    assert.equal(readLastUid('unused'), 21);
    persistLastUid('unused', 22);
    assert.equal(readLastUid('unused'), 22);
  } finally {
    try { fs.unlinkSync(f); } catch (_) {}
    if (prev === undefined) delete process.env.ASMLTR_EMAIL_LASTUID_FILE;
    else process.env.ASMLTR_EMAIL_LASTUID_FILE = prev;
  }
});
