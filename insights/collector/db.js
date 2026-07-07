'use strict';
/**
 * asmltr-insights — SQLite layer (plan §B1/§B2).
 *
 * `events` is the append-only spine; sessions/usage_rollup/notifications are
 * projections maintained in the SAME transaction as each ingest. Synchronous
 * better-sqlite3 fits a single-writer collector.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { buildEvent } = require('../../shared/events');

const DB_PATH = process.env.ASMLTR_INSIGHTS_DB || path.join(__dirname, 'data', 'insights.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// Migrations: add columns to a pre-existing sessions table (created before they existed).
{
  const cols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  if (!cols.includes('title')) db.exec('ALTER TABLE sessions ADD COLUMN title TEXT');
  if (!cols.includes('location')) db.exec('ALTER TABLE sessions ADD COLUMN location TEXT');
}

const _insEvent = db.prepare(`
  INSERT INTO events (ts, surface, session_id, identity, event_type, tokens_in, tokens_out, cost_usd, payload, source)
  VALUES (@ts, @surface, @session_id, @identity, @event_type, @tokens_in, @tokens_out, @cost_usd, @payload, @source)
`);
const _upsertUsage = db.prepare(`
  INSERT INTO usage_rollup (bucket_hour, surface, identity, tokens_in, tokens_out, cost_usd, msg_count)
  VALUES (@bucket, @surface, @identity, @ti, @to, @cost, @msg)
  ON CONFLICT(bucket_hour, surface, identity) DO UPDATE SET
    tokens_in = tokens_in + @ti, tokens_out = tokens_out + @to,
    cost_usd = cost_usd + @cost, msg_count = msg_count + @msg
`);
const _insNotif = db.prepare(`
  INSERT INTO notifications (ts, channel, title, body, surface, session_id)
  VALUES (@ts, @channel, @title, @body, @surface, @session_id)
`);
const _upsertSession = db.prepare(`
  INSERT INTO sessions (session_id, surface, kind, identity, status, started_unix, last_activity_unix, tokens_total, tool_count, updated_unix)
  VALUES (@sid, @surface, @kind, @identity, @status, @now, @now, @tokens, @tools, @now)
  ON CONFLICT(session_id) DO UPDATE SET
    surface = excluded.surface,
    identity = COALESCE(excluded.identity, sessions.identity),
    status = excluded.status,
    last_activity_unix = excluded.last_activity_unix,
    tokens_total = sessions.tokens_total + @tokens,
    tool_count = sessions.tool_count + @tools,
    updated_unix = excluded.updated_unix
`);

const SESSION_EVENTS = new Set(['inbound', 'outbound', 'tool', 'token-usage', 'session-start']);

/**
 * Ingest one event (already-built shape from shared/events.js). Writes the spine
 * row + all projections atomically. Returns the stored event, or throws on a
 * malformed event so the HTTP layer can 400.
 */
const ingestEvent = db.transaction((raw) => {
  // Normalize via the shared contract: defaults ts/tokens, validates enums
  // (throws on bad surface/event_type → HTTP layer turns it into a 400).
  const evt = buildEvent(raw);

  const row = {
    ts: evt.ts,
    surface: evt.surface,
    session_id: evt.session_id || null,
    identity: evt.identity || null,
    event_type: evt.event_type,
    tokens_in: evt.tokens_in || 0,
    tokens_out: evt.tokens_out || 0,
    cost_usd: evt.cost_usd || 0,
    payload: evt.payload ? JSON.stringify(evt.payload) : null,
    source: evt.source || null,
  };
  _insEvent.run(row);

  // usage rollup (hourly bucket). Count an inbound as one message.
  if (row.tokens_in || row.tokens_out || row.cost_usd || row.event_type === 'inbound') {
    _upsertUsage.run({
      bucket: Math.floor(row.ts / 3600000) * 3600000,
      surface: row.surface,
      identity: row.identity || '',
      ti: row.tokens_in, to: row.tokens_out, cost: row.cost_usd,
      msg: row.event_type === 'inbound' ? 1 : 0,
    });
  }

  // notifications feed
  if (row.event_type === 'notification') {
    _insNotif.run({
      ts: row.ts,
      channel: (evt.payload && evt.payload.channel) || 'unknown',
      title: (evt.payload && evt.payload.title) || null,
      body: (evt.payload && evt.payload.body) || null,
      surface: row.surface,
      session_id: row.session_id,
    });
  }

  // session projection (CC sessions are overlaid by reconcile.js; this covers core/channels/bots)
  if (row.session_id && SESSION_EVENTS.has(row.event_type)) {
    _upsertSession.run({
      sid: row.session_id,
      surface: row.surface,
      // Conversations are ephemeral session records, NOT daemons. (The actual
      // long-running connector bots are managed via the connector manager, not here.)
      kind: 'ephemeral',
      identity: row.identity,
      status: row.event_type === 'session-end' ? 'ended' : 'active',
      now: row.ts,
      tokens: row.tokens_in + row.tokens_out,
      tools: row.event_type === 'tool' ? 1 : 0,
    });
    // origin (server · channel) rides on inbound events — record it on the session for the card
    if (row.event_type === 'inbound' && evt.payload && (evt.payload.server || evt.payload.channel)) {
      const loc = fmtLocation(evt.payload.server, evt.payload.channel);
      if (loc) _setLocation.run(loc, row.session_id);
    }
  }

  return evt;
});
function fmtLocation(server, channel) {
  const s = server && server !== 'Direct Message' ? server : null;
  const c = channel && channel !== 'DM' ? channel : null;
  if (s && c) return `${s} · #${c}`;
  if (s) return s;
  if (c) return `#${c}`;
  return server || null; // e.g. "Direct Message"
}

// --- read queries (REST API) -------------------------------------------------
const q = {
  sessions: db.prepare(`SELECT * FROM sessions ORDER BY last_activity_unix DESC LIMIT @limit`),
  activeSessions: db.prepare(`SELECT * FROM sessions WHERE status = 'active' ORDER BY last_activity_unix DESC`),
  events: db.prepare(`
    SELECT * FROM events
    WHERE (@surface IS NULL OR surface = @surface)
      AND (@identity IS NULL OR identity = @identity)
      AND (@session IS NULL OR session_id = @session)
      AND ts >= @since
    ORDER BY ts DESC LIMIT @limit
  `),
  usage: db.prepare(`SELECT * FROM usage_rollup WHERE bucket_hour >= @since ORDER BY bucket_hour DESC`),
  system: db.prepare(`SELECT * FROM system_metrics WHERE ts >= @since ORDER BY ts DESC LIMIT @limit`),
  notifications: db.prepare(`SELECT * FROM notifications ORDER BY ts DESC LIMIT @limit`),
};

// --- session upsert used by reconcile.js (richer column set) -----------------
const _reconcileUpsert = db.prepare(`
  INSERT INTO sessions (session_id, surface, kind, pid, identity, context, working_dir, task, status,
                        started_unix, last_activity_unix, tool_count, multiplexer, tmux_target, updated_unix)
  VALUES (@sid, @surface, @kind, @pid, @identity, @context, @working_dir, @task, @status,
          @started_unix, @last_activity_unix, @tool_count, @multiplexer, @tmux_target, @now)
  ON CONFLICT(session_id) DO UPDATE SET
    pid = excluded.pid, context = excluded.context, working_dir = excluded.working_dir,
    task = excluded.task, status = excluded.status, last_activity_unix = excluded.last_activity_unix,
    tool_count = excluded.tool_count, multiplexer = excluded.multiplexer,
    tmux_target = excluded.tmux_target, updated_unix = excluded.updated_unix
`);
function reconcileUpsert(s) { _reconcileUpsert.run({ tmux_target: null, ...s }); }

const _setTitle = db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?');
function setTitle(session_id, title) { _setTitle.run(title || null, session_id); }
const _setLocation = db.prepare('UPDATE sessions SET location = ? WHERE session_id = ?');
const _getTitle = db.prepare('SELECT title FROM sessions WHERE session_id = ?');
function getTitle(session_id) { const r = _getTitle.get(session_id); return r ? r.title : null; }

// --- system sample (sampler.js): write metrics table + a timeline event ------
const _insMetric = db.prepare(`
  INSERT OR REPLACE INTO system_metrics (ts, cpu_pct, load1, load5, mem_used_mb, mem_total_mb, disk_used_pct, disk_free_gb)
  VALUES (@ts, @cpu_pct, @load1, @load5, @mem_used_mb, @mem_total_mb, @disk_used_pct, @disk_free_gb)
`);
const insertSystemSample = db.transaction((s) => {
  _insMetric.run(s);
  _insEvent.run({
    ts: s.ts, surface: 'system', session_id: null, identity: null, event_type: 'system-sample',
    tokens_in: 0, tokens_out: 0, cost_usd: 0,
    payload: JSON.stringify({ cpu_pct: s.cpu_pct, mem_used_mb: s.mem_used_mb, disk_used_pct: s.disk_used_pct }),
    source: 'sampler',
  });
});

module.exports = { db, ingestEvent, reconcileUpsert, setTitle, getTitle, insertSystemSample, q, DB_PATH };
