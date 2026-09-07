'use strict';
/**
 * IMAP IDLE watchdog (#34 half-open flap).
 *
 * IDLE stays the new-mail path. A periodic DONE-then-NOOP proves the socket is
 * alive; ImapFlow maxIdleTime refreshes IDLE before NAT/Gmail drop it silently.
 * Probe/fail/reconnect lines are appended to a JSONL journal so a chronic flap
 * is visible after the in-memory manager ring (LOG_RING=200) rotates.
 */
const os = require('os');
const path = require('path');
const { persistAuthRejectLine } = require('./auth-reject-persist');

const DEFAULT_IMAP_PROBE_MS = 60000;
const DEFAULT_IMAP_PROBE_TIMEOUT_MS = 35000;
const DEFAULT_IMAP_MAX_IDLE_MS = 10 * 60 * 1000;
const DEFAULT_IMAP_RECONNECT_BASE_MS = 10000;
const DEFAULT_IMAP_RECONNECT_MAX_MS = 5 * 60 * 1000;
const DEFAULT_IMAP_BACKOFF_AFTER = 3;
const PROBE_FAIL_WINDOW_MS = 60 * 60 * 1000;

function envMs(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

const IMAP_PROBE_MS = envMs('ASMLTR_EMAIL_IMAP_PROBE_MS', DEFAULT_IMAP_PROBE_MS);
const IMAP_PROBE_TIMEOUT_MS = envMs('ASMLTR_EMAIL_IMAP_PROBE_TIMEOUT_MS', DEFAULT_IMAP_PROBE_TIMEOUT_MS);
const IMAP_MAX_IDLE_MS = envMs('ASMLTR_EMAIL_IMAP_MAX_IDLE_MS', DEFAULT_IMAP_MAX_IDLE_MS);
const IMAP_RECONNECT_BASE_MS = envMs('ASMLTR_EMAIL_IMAP_RECONNECT_BASE_MS', DEFAULT_IMAP_RECONNECT_BASE_MS);
const IMAP_RECONNECT_MAX_MS = envMs('ASMLTR_EMAIL_IMAP_RECONNECT_MAX_MS', DEFAULT_IMAP_RECONNECT_MAX_MS);
const IMAP_BACKOFF_AFTER = envInt('ASMLTR_EMAIL_IMAP_BACKOFF_AFTER', DEFAULT_IMAP_BACKOFF_AFTER);

function imapJournalFile(instanceId) {
  if (process.env.ASMLTR_EMAIL_IMAP_JOURNAL) return process.env.ASMLTR_EMAIL_IMAP_JOURNAL;
  const id = String(instanceId || 'default').replace(/[^A-Za-z0-9._-]+/g, '_');
  return path.join(os.homedir(), '.asmltr', `email-imap-${id}.jsonl`);
}

function sanitizeImapJournalReason(s) {
  return String(s || '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function buildImapJournalEntry({ event, reason, streak, delayMs, failsHour, now } = {}) {
  return {
    ts: new Date(now || Date.now()).toISOString(),
    event: String(event || 'imap.event'),
    reason: sanitizeImapJournalReason(reason),
    streak: Number(streak) || 0,
    delay_ms: Number(delayMs) || 0,
    fails_hour: Number(failsHour) || 0,
  };
}

function persistImapJournalLine(filePath, entry) {
  persistAuthRejectLine(filePath, entry);
}

function persistImapJournal(instanceId, entry) {
  try {
    persistImapJournalLine(imapJournalFile(instanceId), entry);
  } catch (_) {}
}

function formatImapJournalLog(entry) {
  const e = entry || {};
  const bits = [e.event || 'imap.event'];
  if (e.reason) bits.push(e.reason);
  if (e.streak) bits.push(`streak=${e.streak}`);
  if (e.delay_ms) bits.push(`backoff=${e.delay_ms}ms`);
  if (e.fails_hour) bits.push(`fails_hour=${e.fails_hour}`);
  return bits.join(' ');
}

function createProbeFailWindow(windowMs = PROBE_FAIL_WINDOW_MS) {
  const times = [];
  function prune(now) {
    const cutoff = now - windowMs;
    while (times.length && times[0] < cutoff) times.shift();
  }
  return {
    record(now = Date.now()) {
      times.push(now);
      prune(now);
      return times.length;
    },
    count(now = Date.now()) {
      prune(now);
      return times.length;
    },
  };
}

function nextReconnectDelayMs(failStreak, {
  baseMs = IMAP_RECONNECT_BASE_MS,
  maxMs = IMAP_RECONNECT_MAX_MS,
  backoffAfter = IMAP_BACKOFF_AFTER,
} = {}) {
  const n = Math.max(0, Number(failStreak) || 0);
  if (n <= backoffAfter) return baseMs;
  return Math.min(maxMs, baseMs * (2 ** (n - backoffAfter)));
}

function imapProbeTickDecision({ stopped, busy, probing, usable, reconnectPending } = {}) {
  if (stopped) return { action: 'skip' };
  if (busy) return { action: 'skip_busy' };
  if (probing) return { action: 'skip' };
  if (reconnectPending) return { action: 'skip' };
  if (!usable) return { action: 'heal' };
  return { action: 'probe' };
}

function createImapFailureGate() {
  let noted = false;
  return {
    reset() { noted = false; },
    note() {
      if (noted) return false;
      noted = true;
      return true;
    },
    get noted() { return noted; },
  };
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function imapFlowWatchOptions({ host, port, auth, maxIdleTime } = {}) {
  const idle = maxIdleTime != null ? Number(maxIdleTime) : IMAP_MAX_IDLE_MS;
  return {
    host,
    port: port || 993,
    secure: true,
    auth,
    logger: false,
    maxIdleTime: Number.isFinite(idle) && idle > 0 ? idle : DEFAULT_IMAP_MAX_IDLE_MS,
  };
}

function baselineLastUid(lastUid, processBacklog, uidNext) {
  if (lastUid >= 0) return lastUid;
  return processBacklog ? 0 : ((uidNext || 1) - 1);
}

/**
 * ImapFlow: connection.preCheck() writes DONE and waits until IDLE has ended.
 * idleEnd / breakIdle are accepted so tests (and future APIs) can break IDLE too.
 */
function idleBreakFn(imap) {
  if (!imap) return null;
  if (typeof imap.preCheck === 'function') return imap.preCheck.bind(imap);
  if (typeof imap.idleEnd === 'function') return imap.idleEnd.bind(imap);
  if (typeof imap.breakIdle === 'function') return imap.breakIdle.bind(imap);
  return null;
}

async function breakImapIdle(imap, timeoutMs = IMAP_PROBE_TIMEOUT_MS) {
  if (!imap || imap.idling === false) return 'skipped';
  const ender = idleBreakFn(imap);
  if (!ender) return 'deferred';
  const p = ender();
  if (!p || typeof p.then !== 'function') return 'done';
  await withTimeout(p.catch(() => {}), timeoutMs, 'idle-end timeout');
  return 'done';
}

async function imapNoopProbe(imap, timeoutMs = IMAP_PROBE_TIMEOUT_MS) {
  const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : IMAP_PROBE_TIMEOUT_MS;
  const started = Date.now();
  await breakImapIdle(imap, ms);
  const remain = Math.max(1, ms - (Date.now() - started));
  const np = imap.noop();
  if (np && typeof np.catch === 'function') np.catch(() => {});
  await withTimeout(np, remain, 'noop timeout');
}

module.exports = {
  DEFAULT_IMAP_PROBE_MS,
  DEFAULT_IMAP_PROBE_TIMEOUT_MS,
  DEFAULT_IMAP_MAX_IDLE_MS,
  DEFAULT_IMAP_RECONNECT_BASE_MS,
  DEFAULT_IMAP_RECONNECT_MAX_MS,
  DEFAULT_IMAP_BACKOFF_AFTER,
  PROBE_FAIL_WINDOW_MS,
  IMAP_PROBE_MS,
  IMAP_PROBE_TIMEOUT_MS,
  IMAP_MAX_IDLE_MS,
  IMAP_RECONNECT_BASE_MS,
  IMAP_RECONNECT_MAX_MS,
  IMAP_BACKOFF_AFTER,
  imapJournalFile,
  sanitizeImapJournalReason,
  buildImapJournalEntry,
  persistImapJournalLine,
  persistImapJournal,
  formatImapJournalLog,
  createProbeFailWindow,
  nextReconnectDelayMs,
  imapProbeTickDecision,
  imapFlowWatchOptions,
  baselineLastUid,
  breakImapIdle,
  imapNoopProbe,
  createImapFailureGate,
  withTimeout,
};
