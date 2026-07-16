'use strict';
/**
 * Data silos — the migratable, self-describing data containers behind the assistant's memory and its
 * project workspaces (roadmap: docs/ROADMAP-VAULT-SILOS-BACKUP.md).
 *
 * A directory is a silo iff it carries a `.silo/manifest.json` marker (like `.git/` makes a repo). The
 * filesystem IS the schema — discovery is search over the real files; any index is a rebuildable
 * accelerator, never the source of truth. Structure comes from a **template** at creation (no default
 * zones). File ops + search go through the `shared/storage.js` driver, so a silo is backend-agnostic;
 * the built-in local driver is the default (silos are local-first).
 *
 * The **Self silo** (type `self`) is the assistant's own memory + the default home for artifacts.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const storage = require('./storage');
const version = require('./version');

function silosRoot() { return process.env.ASMLTR_SILOS_ROOT || path.join(os.homedir(), '.asmltr', 'silos'); }
function ver() { try { return version.readVersion(); } catch (_) { return '0.0.0'; } }

// Templates seed structure at creation; after that a silo is free-form. Zones are a convenience for
// humans + a default home for the agent — never enforced (search is the recall guarantee).
const TEMPLATES = {
  generic: { folders: [], desc: 'A blank silo.' },
  self: { folders: ['artifacts', 'workspaces', 'memory/identity', 'memory/transcripts', 'memory/dreams'],
    desc: "The assistant's own memory + the default birthplace of every artifact it creates." },
  'software-project': { folders: ['src', 'docs', 'artifacts'], desc: 'A software project.' },
  research: { folders: ['sources', 'notes', 'findings'], desc: 'Research materials for a topic.' },
  media: { folders: ['images', 'audio', 'video', 'docs'], desc: 'Media assets.' },
};

function readmeFor(name, type) {
  const t = TEMPLATES[type] || TEMPLATES.generic;
  return `# ${name}\n\nAn asmltr **${type}** data silo — ${t.desc}\n\n` +
    'Interact via the `asmltr silo` commands (`ls` · `tree` · `find` · `get` · `put` · `overview`).\n' +
    `Created with asmltr ${ver()}. The \`.silo/\` directory holds the manifest + derived index — leave it in place.\n`;
}

const isInternal = (p) => p === '.silo' || p.startsWith('.silo/') || p === 'README.md';

class Silo {
  constructor(dir) { this.dir = dir; this.store = storage.getStorage({ type: 'local', config: { root: dir } }); }
  manifest() { try { return JSON.parse(fs.readFileSync(path.join(this.dir, '.silo', 'manifest.json'), 'utf8')); } catch (_) { return null; } }

  /** Patch editable manifest fields (name/description/…). Identity + provenance keys are protected. */
  setManifest(patch = {}) {
    const PROTECTED = new Set(['id', 'type', 'manifest_version', 'created_with', 'min_asmltr', 'created_at', 'storage']);
    const m = this.manifest() || {};
    for (const [k, v] of Object.entries(patch)) if (!PROTECTED.has(k)) m[k] = v;
    fs.writeFileSync(path.join(this.dir, '.silo', 'manifest.json'), JSON.stringify(m, null, 2));
    return m;
  }

  // ---- file-manager verbs (delegate to the storage driver; paths are silo-relative) ----
  async ls(p = '') { return (await this.store.list(p, { recursive: false })).filter((e) => !isInternal(e.path)); }
  async tree(p = '', depth = Infinity) {
    const base = String(p || '').replace(/\/+$/, '');
    const baseDepth = base ? base.split('/').length : 0;
    return (await this.store.list(p, { recursive: true }))
      .filter((e) => !isInternal(e.path) && (e.path.split('/').length - baseDepth) <= depth);
  }
  stat(p) { return this.store.stat(p); }
  mkdir(p) { return this.store.mkdir(p); }
  rm(p) { return this.store.remove(p); }
  mv(a, b) { return this.store.move(a, b); }
  put(p, data) { return this.store.put(p, data); }
  get(p) { return this.store.get(p); }

  /** A cheap self-describing map for orientation (manifest + zones + file count). */
  async overview() {
    const m = this.manifest() || {};
    const all = (await this.store.list('', { recursive: true })).filter((e) => !isInternal(e.path));
    const zones = all.filter((e) => e.type === 'dir' && !e.path.includes('/')).map((e) => e.path).sort();
    return { id: m.id, name: m.name, type: m.type, created_with: m.created_with, dir: this.dir,
      zones, files: all.filter((e) => e.type === 'file').length };
  }

  /**
   * Search. L0 metadata (filename substring + type/date filters) always; `content:true` adds L1
   * keyword search via ripgrep on the local silo (falls back to name-only if rg is absent).
   */
  async find(query, { in: inPath = '', type, since, content = false } = {}) {
    let items = (await this.store.list(inPath, { recursive: true })).filter((e) => e.type === 'file' && !isInternal(e.path));
    if (type) { const ext = '.' + String(type).toLowerCase().replace(/^\./, ''); items = items.filter((e) => e.path.toLowerCase().endsWith(ext)); }
    if (since) { const t = Date.parse(since); if (!isNaN(t)) items = items.filter((e) => (e.mtime || 0) >= t); }
    const q = String(query || '').toLowerCase();
    const byName = q ? items.filter((e) => e.path.toLowerCase().includes(q)) : items;
    const results = new Map(byName.map((e) => [e.path, { path: e.path, size: e.size, mtime: e.mtime, match: 'name' }]));
    if (content && q) {
      const hits = this._contentSearch(query, items);
      for (const rel of hits) results.set(rel, { ...(results.get(rel) || { path: rel }), match: results.has(rel) ? 'name+content' : 'content' });
    }
    return [...results.values()];
  }

  /** Keyword content search — ripgrep if available (fast), else a pure-JS scan of text files. */
  _contentSearch(query, items) {
    try {
      const out = execFileSync('rg', ['-l', '-i', '--no-messages', '-e', query, this.dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return out.split('\n').filter(Boolean).map((f) => path.relative(this.dir, f)).filter((p) => !isInternal(p));
    } catch (_) { /* rg absent → JS fallback below */ }
    const TEXT = /\.(md|txt|json|jsonl|js|ts|tsx|vue|py|csv|log|html?|css|ya?ml|xml|sh|toml|ini|sql)$/i;
    const q = String(query).toLowerCase();
    const hits = [];
    for (const e of items) {
      if (!TEXT.test(e.path) || (e.size || 0) > 5 << 20) continue; // skip binary + >5MB
      try { if (fs.readFileSync(path.join(this.dir, e.path), 'utf8').toLowerCase().includes(q)) hits.push(e.path); } catch (_) {}
    }
    return hits;
  }
}

/** Create a silo from a template. Idempotent-ish: throws if the id already exists. */
function create({ id, name, type = 'generic' }) {
  if (!TEMPLATES[type]) throw new Error('unknown silo type: ' + type);
  const dir = path.join(silosRoot(), id);
  if (fs.existsSync(path.join(dir, '.silo', 'manifest.json'))) throw new Error('silo already exists: ' + id);
  fs.mkdirSync(path.join(dir, '.silo'), { recursive: true });
  const v = ver();
  const manifest = { id, name: name || id, type, manifest_version: 1, created_with: v, min_asmltr: v, created_at: Date.now(), storage: { backend: 'local' } };
  fs.writeFileSync(path.join(dir, '.silo', 'manifest.json'), JSON.stringify(manifest, null, 2));
  for (const f of TEMPLATES[type].folders) fs.mkdirSync(path.join(dir, f), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), readmeFor(name || id, type));
  return new Silo(dir);
}

/** Open an existing silo by id or absolute path. */
function open(id) {
  const dir = path.isAbsolute(id) ? id : path.join(silosRoot(), id);
  if (!fs.existsSync(path.join(dir, '.silo', 'manifest.json'))) throw new Error('not a silo: ' + id);
  return new Silo(dir);
}

/** Every silo under the root (discovered by the `.silo/` marker). */
function list() {
  try { return fs.readdirSync(silosRoot()).map((d) => { try { return open(d).manifest(); } catch (_) { return null; } }).filter(Boolean); }
  catch (_) { return []; }
}

/** Delete a silo by id (never a path — deletion is confined to a plain child of the silos root). */
function remove(id) {
  if (!id || /[\\/]|\.\./.test(id)) throw new Error('invalid silo id: ' + id);
  const dir = path.join(silosRoot(), id);
  if (!fs.existsSync(path.join(dir, '.silo', 'manifest.json'))) throw new Error('not a silo: ' + id);
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/** The Self silo — created (from the `self` template) if absent. */
function ensureSelf(name) {
  const existing = list().find((m) => m.type === 'self');
  if (existing) return open(existing.id);
  return create({ id: 'self', name: `${name || 'Assistant'} — Self`, type: 'self' });
}

module.exports = { create, open, list, remove, ensureSelf, Silo, silosRoot, TEMPLATES };
