'use strict';
/**
 * asmltr-core — session store (plan §A2).
 *
 * Maps a channel-computed `conversation_key` → the SDK-assigned
 * `engine_session_id`. The SDK assigns the id (unlike the CLI's --session-id);
 * we capture it from the first `system`/`result` event and persist it, then
 * resume via options.resume. This subsumes Discord per-server, Telegram
 * per-user, MCP per-user, etc. — they are all just different key formulas.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

const DB_PATH = process.env.ASMLTR_CORE_DB || path.join(__dirname, '..', 'data', 'eve-core.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    conversation_key   TEXT PRIMARY KEY,
    engine_session_id  TEXT,
    channel            TEXT NOT NULL,
    idle_policy        TEXT NOT NULL DEFAULT 'infinite',  -- 'infinite' | 'idle:<minutes>'
    created_at         INTEGER NOT NULL,
    last_activity_at   INTEGER NOT NULL,
    turn_count         INTEGER NOT NULL DEFAULT 0,
    claim_state        TEXT NOT NULL DEFAULT 'free',       -- free|channel-running|terminal-claimed|paused
    claimed_by         TEXT,
    working_dir        TEXT                                -- where to resume/attach (worktree or default)
  );
`);

// Migration: add working_dir to a pre-existing table (created before this column).
const _cols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
if (!_cols.includes('working_dir')) db.exec('ALTER TABLE sessions ADD COLUMN working_dir TEXT');

const _get = db.prepare('SELECT * FROM sessions WHERE conversation_key = ?');
const _insert = db.prepare(`
  INSERT INTO sessions (conversation_key, channel, idle_policy, created_at, last_activity_at, turn_count, working_dir)
  VALUES (@conversation_key, @channel, @idle_policy, @now, @now, 0, @working_dir)
`);
// Spawn/resume cwd for a session. Neutral default: the running user's home
// (os.homedir()), so the SDK loads the host's project context (CLAUDE.md) but NOT
// whatever project the core process happens to live in. That resolves to /root when
// the core runs as root (the prior hardcoded value) and to the user's home otherwise.
// A hardcoded /root made spawn() fail with EACCES for any non-root user, who can't
// chdir into it. Override with ASMLTR_SESSION_CWD. Resume must use the SAME cwd the
// session was born in (that's how `claude --resume` locates it), so it's per-session.
const DEFAULT_CWD = process.env.ASMLTR_SESSION_CWD || os.homedir();
const _setEngineId = db.prepare('UPDATE sessions SET engine_session_id = ?, last_activity_at = ? WHERE conversation_key = ?');
const _touch = db.prepare('UPDATE sessions SET last_activity_at = ?, turn_count = turn_count + 1 WHERE conversation_key = ?');
const _setClaim = db.prepare('UPDATE sessions SET claim_state = ?, claimed_by = ? WHERE conversation_key = ?');

function nowMs() { return Date.now(); }

/** Get the row for a key, creating it if absent. */
function ensure(conversation_key, channel, idle_policy = 'infinite', working_dir = DEFAULT_CWD) {
  let row = _get.get(conversation_key);
  if (!row) {
    _insert.run({ conversation_key, channel, idle_policy, now: nowMs(), working_dir });
    row = _get.get(conversation_key);
  }
  return row;
}

/**
 * Decide how to run the next turn for a conversation.
 * @returns {{ resume: string|null, key: string }} resume id (or null for a fresh session)
 */
function resolveForTurn(conversation_key, channel, idle_policy = 'infinite', working_dir = DEFAULT_CWD) {
  const row = ensure(conversation_key, channel, idle_policy, working_dir);
  if (!row.engine_session_id) return { resume: null, key: conversation_key };

  // idle:<minutes> policy → start fresh if past the window; 'infinite' always resumes.
  const m = /^idle:(\d+)$/.exec(row.idle_policy || 'infinite');
  if (m) {
    const windowMs = Number(m[1]) * 60 * 1000;
    if (nowMs() - row.last_activity_at > windowMs) return { resume: null, key: conversation_key };
  }
  return { resume: row.engine_session_id, key: conversation_key };
}

/** Persist the SDK-assigned engine session id captured from the event stream. */
function recordEngineId(conversation_key, engine_session_id) {
  if (!engine_session_id) return;
  _setEngineId.run(engine_session_id, nowMs(), conversation_key);
}

/** Bump activity + turn count after a completed turn. */
function touch(conversation_key) {
  _touch.run(nowMs(), conversation_key);
}

/** Takeover bookkeeping (used by the collector/CLI claim/release primitive). */
function setClaim(conversation_key, claim_state, claimed_by = null) {
  _setClaim.run(claim_state, claimed_by, conversation_key);
}

function get(conversation_key) { return _get.get(conversation_key); }

module.exports = { db, ensure, resolveForTurn, recordEngineId, touch, setClaim, get, DB_PATH };
