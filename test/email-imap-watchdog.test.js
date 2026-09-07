'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// #34 flap harden: DONE-then-NOOP (or longer timeout), skip while busy, maxIdleTime,
// reconnect backoff, persisted journal + fails/hour. IDLE stays the new-mail path.
const {
  DEFAULT_IMAP_PROBE_TIMEOUT_MS,
  DEFAULT_IMAP_MAX_IDLE_MS,
  DEFAULT_IMAP_RECONNECT_BASE_MS,
  DEFAULT_IMAP_RECONNECT_MAX_MS,
  DEFAULT_IMAP_BACKOFF_AFTER,
  imapNoopProbe,
  breakImapIdle,
  imapProbeTickDecision,
  nextReconnectDelayMs,
  createProbeFailWindow,
  sanitizeImapJournalReason,
  buildImapJournalEntry,
  persistImapJournalLine,
  imapJournalFile,
  imapFlowWatchOptions,
  baselineLastUid,
} = require('../connectors/types/email/imap-watchdog.js');

test('probe timeout default is 30–45s (half-open DONE+NOOP can exceed 15s)', () => {
  assert.ok(DEFAULT_IMAP_PROBE_TIMEOUT_MS >= 30000 && DEFAULT_IMAP_PROBE_TIMEOUT_MS <= 45000);
});

test('maxIdleTime default refreshes IDLE on a minutes-scale (not polling)', () => {
  assert.ok(DEFAULT_IMAP_MAX_IDLE_MS >= 5 * 60 * 1000 && DEFAULT_IMAP_MAX_IDLE_MS <= 15 * 60 * 1000);
});

test('probe tick skips while busy (do not NOOP during fetchNew)', () => {
  const idle = { stopped: false, busy: false, probing: false, usable: true };
  assert.equal(imapProbeTickDecision(idle).action, 'probe');
  assert.equal(imapProbeTickDecision({ ...idle, busy: true }).action, 'skip_busy');
  assert.equal(imapProbeTickDecision({ ...idle, probing: true }).action, 'skip');
  assert.equal(imapProbeTickDecision({ ...idle, stopped: true }).action, 'skip');
  assert.equal(imapProbeTickDecision({ ...idle, usable: false }).action, 'heal');
});

test('reconnect stays at base until N fails, then exponential backoff, then cap', () => {
  const after = DEFAULT_IMAP_BACKOFF_AFTER;
  const base = DEFAULT_IMAP_RECONNECT_BASE_MS;
  const max = DEFAULT_IMAP_RECONNECT_MAX_MS;
  assert.equal(nextReconnectDelayMs(1), base);
  assert.equal(nextReconnectDelayMs(after), base);
  assert.equal(nextReconnectDelayMs(after + 1), base * 2);
  assert.equal(nextReconnectDelayMs(after + 2), base * 4);
  assert.ok(nextReconnectDelayMs(99) <= max);
  assert.equal(nextReconnectDelayMs(99), max);
});

test('probe calls preCheck (DONE / break IDLE) before NOOP when idling', async () => {
  const order = [];
  const imap = {
    idling: true,
    preCheck: async () => { order.push('preCheck'); },
    noop: async () => { order.push('noop'); },
  };
  await imapNoopProbe(imap, 500);
  assert.deepEqual(order, ['preCheck', 'noop']);
});

test('probe does not call preCheck when not idling', async () => {
  let pre = 0;
  await imapNoopProbe({
    idling: false,
    preCheck: async () => { pre++; },
    noop: async () => ({}),
  }, 500);
  assert.equal(pre, 0);
});

test('probe rejects when DONE/preCheck hangs (half-open IDLE)', async () => {
  const started = Date.now();
  await assert.rejects(
    () => imapNoopProbe({
      idling: true,
      preCheck: () => new Promise(() => {}),
      noop: async () => { throw new Error('noop should not run'); },
    }, 200),
    /idle-end timeout|noop timeout/,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 150 && elapsed < 2000, `timed out near 200ms, took ${elapsed}ms`);
});

test('breakImapIdle is a no-op when not idling', async () => {
  let pre = 0;
  assert.equal(await breakImapIdle({ idling: false, preCheck: () => { pre++; } }, 50), 'skipped');
  assert.equal(pre, 0);
});

test('fails/hour window counts then expires', () => {
  const w = createProbeFailWindow(1000);
  const t0 = 1_000_000;
  assert.equal(w.record(t0), 1);
  assert.equal(w.record(t0 + 100), 2);
  assert.equal(w.count(t0 + 999), 2);
  assert.equal(w.count(t0 + 1100), 1); // first sample aged out
  assert.equal(w.count(t0 + 2100), 0);
});

test('journal reason strips mailbox addresses (PII-free public tree)', () => {
  const s = sanitizeImapJournalReason('connect failed for bot@example.com socket');
  assert.ok(!s.includes('@'));
  assert.match(s, /\[redacted\]/);
});

test('journal entry is JSON-serializable and PII-free', () => {
  const e = buildImapJournalEntry({
    event: 'imap.probe_fail',
    reason: 'noop timeout for owner@example.com',
    streak: 4,
    delayMs: 20000,
    failsHour: 3,
    now: Date.parse('2026-09-07T12:00:00.000Z'),
  });
  assert.equal(e.event, 'imap.probe_fail');
  assert.equal(e.streak, 4);
  assert.equal(e.delay_ms, 20000);
  assert.equal(e.fails_hour, 3);
  assert.equal(e.ts, '2026-09-07T12:00:00.000Z');
  assert.ok(!JSON.stringify(e).includes('@'));
});

test('persist journal line is append-only 0o600 JSONL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imap-journal-'));
  const f = path.join(dir, 'imap.jsonl');
  persistImapJournalLine(f, { ts: 't1', event: 'imap.probe_fail', reason: 'noop timeout' });
  persistImapJournalLine(f, { ts: 't2', event: 'imap.reconnect', delay_ms: 20000 });
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).event, 'imap.probe_fail');
  assert.equal(JSON.parse(lines[1]).delay_ms, 20000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('journal path override is env, else ~/.asmltr/email-imap-<id>.jsonl', () => {
  const prev = process.env.ASMLTR_EMAIL_IMAP_JOURNAL;
  process.env.ASMLTR_EMAIL_IMAP_JOURNAL = '/tmp/imap-journal-test.jsonl';
  try {
    assert.equal(imapJournalFile('inst'), '/tmp/imap-journal-test.jsonl');
  } finally {
    if (prev === undefined) delete process.env.ASMLTR_EMAIL_IMAP_JOURNAL;
    else process.env.ASMLTR_EMAIL_IMAP_JOURNAL = prev;
  }
  const p = imapJournalFile('mail-1');
  assert.match(p, /email-imap-mail-1\.jsonl$/);
  assert.ok(!p.includes('@'));
});

test('watch options set ImapFlow maxIdleTime (IDLE refresh, not poll replace)', () => {
  const opts = imapFlowWatchOptions({
    host: 'imap.example.com',
    port: 993,
    auth: { user: 'u', pass: 'p' },
    maxIdleTime: 600000,
  });
  assert.equal(opts.maxIdleTime, 600000);
  assert.equal(opts.secure, true);
  assert.equal(opts.logger, false);
  assert.equal(opts.host, 'imap.example.com');
});

test('UID cursor baseline is once; reconnect keeps lastUid', () => {
  assert.equal(baselineLastUid(42, false, 99), 42);
  assert.equal(baselineLastUid(42, true, 99), 42);
  assert.equal(baselineLastUid(-1, false, 80), 79);
  assert.equal(baselineLastUid(-1, true, 80), 0);
});
