'use strict';
/** asmltr connector manager — instance registry (SQLite). */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DB_PATH = process.env.ASMLTR_CONNECTORS_DB || path.join(__dirname, 'data', 'connectors.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS instances (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL,
    name        TEXT NOT NULL,
    config_json TEXT NOT NULL DEFAULT '{}',
    enabled     INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
`);

const _all = db.prepare('SELECT * FROM instances ORDER BY created_at');
const _get = db.prepare('SELECT * FROM instances WHERE id = ?');
const _ins = db.prepare('INSERT INTO instances (id,type,name,config_json,enabled,created_at,updated_at) VALUES (@id,@type,@name,@config_json,@enabled,@now,@now)');
const _del = db.prepare('DELETE FROM instances WHERE id = ?');

function hydrate(row) {
  if (!row) return null;
  return { id: row.id, type: row.type, name: row.name, config: JSON.parse(row.config_json), enabled: !!row.enabled, created_at: row.created_at, updated_at: row.updated_at };
}

function list() { return _all.all().map(hydrate); }
function get(id) { return hydrate(_get.get(id)); }

function create({ type, name, config = {}, enabled = false }) {
  const id = crypto.randomUUID();
  const now = Date.now();
  _ins.run({ id, type, name: name || type, config_json: JSON.stringify(config), enabled: enabled ? 1 : 0, now });
  return get(id);
}

function update(id, fields) {
  const row = get(id);
  if (!row) return null;
  const name = fields.name != null ? fields.name : row.name;
  const config = fields.config != null ? fields.config : row.config;
  const enabled = fields.enabled != null ? (fields.enabled ? 1 : 0) : (row.enabled ? 1 : 0);
  db.prepare('UPDATE instances SET name=?, config_json=?, enabled=?, updated_at=? WHERE id=?')
    .run(name, JSON.stringify(config), enabled, Date.now(), id);
  return get(id);
}

function remove(id) { return _del.run(id).changes > 0; }

module.exports = { db, list, get, create, update, remove, DB_PATH };
