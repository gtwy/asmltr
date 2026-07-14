'use strict';
/**
 * Body-schema — the live graph of the assistant's PARTS (sessions) and how they relate.
 *
 * This is proprioception's afferent integration: structural, cheap, no LLM. It answers "where are all
 * my limbs and how do they connect" from data the collector already ingests. Nodes = active sessions;
 * structural edges:
 *   colocated    — parts working in the same repo (from real tool file-activity — the collision radar)
 *   communicated — one part announced to another (from recorded `announce` control events)
 * The richer SEMANTIC edges (feeds / duplicates / same-subject / loops-back) are the reflector's job
 * (1b) — only meaning can see those; structure gives the reliable skeleton they hang on.
 */
const fs = require('fs');
const path = require('path');

// file paths a tool call touched (mirrors the /api/map derivation)
function pathsFromTool(payload) {
  let p; try { p = JSON.parse(payload); } catch { return []; }
  let inp = p && p.input;
  if (typeof inp === 'string') { try { inp = JSON.parse(inp); } catch {} }
  const out = [];
  if (inp && typeof inp === 'object') {
    for (const k of ['file_path', 'notebook_path', 'path']) if (typeof inp[k] === 'string' && inp[k].startsWith('/')) out.push(inp[k]);
  }
  return out;
}
const _repoCache = new Map();
function repoRoot(dir) {
  if (!dir) return null;
  if (_repoCache.has(dir)) return _repoCache.get(dir);
  let d = dir, root = dir;
  for (let i = 0; i < 15 && d && d !== '/'; i++) { try { if (fs.existsSync(path.join(d, '.git'))) { root = d; break; } } catch {} d = path.dirname(d); }
  _repoCache.set(dir, root);
  return root;
}

/** Build the body-schema graph from the collector DB. */
function buildSchema(dbmod, { since } = {}) {
  const now = Date.now();
  // Default window = the day's body. Status stays 'active' forever (channel sessions never emit an
  // end), so the raw list is a graveyard of stale limbs; recency is the honest liveness signal.
  // 24h shows the parts that actually did something today (~10) and drops the ancient ~45. The GUI
  // can widen or narrow via ?since — proprioception with an adjustable depth of field.
  since = since || now - 24 * 3600000;
  const sessions = dbmod.q.activeSessions.all().filter((s) => (s.last_activity_unix || 0) > since);
  const byId = {}; for (const s of sessions) byId[s.session_id] = s;

  const nodes = sessions.map((s) => ({
    session_id: s.session_id, surface: s.surface, title: s.title || null, activity: s.activity || null,
    working_dir: s.working_dir || null, status: s.status, tokens: s.tokens_total || 0, tools: s.tool_count || 0,
    last_activity_unix: s.last_activity_unix || 0,
    age_min: Math.round((now - (s.last_activity_unix || now)) / 60000), // minutes since this part last acted
  }));

  // per-session dominant repo (from recent tool activity)
  const dirs = {};
  for (const r of dbmod.q.toolEventsSince.all({ since })) {
    if (!byId[r.session_id]) continue;
    for (const fp of pathsFromTool(r.payload)) {
      const d = fp.replace(/\/[^/]*$/, '') || '/';
      (dirs[r.session_id] = dirs[r.session_id] || {});
      dirs[r.session_id][d] = (dirs[r.session_id][d] || 0) + 1;
    }
  }
  const repoOf = {};
  for (const sid of Object.keys(dirs)) {
    const top = Object.entries(dirs[sid]).sort((a, b) => b[1] - a[1])[0];
    if (top) repoOf[sid] = repoRoot(top[0]);
  }
  // annotate nodes with their live repo (nice for the GUI)
  for (const n of nodes) if (repoOf[n.session_id]) n.repo = repoOf[n.session_id];

  const edges = []; const seen = new Set();
  const addEdge = (a, b, kind, detail) => {
    if (!a || !b || a === b) return;
    const k = [a, b].sort().join('|') + '|' + kind;
    if (seen.has(k)) return; seen.add(k);
    edges.push({ from: a, to: b, kind, detail: detail || null });
  };

  // colocated — same repo root
  const ids = Object.keys(repoOf);
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    if (repoOf[ids[i]] && repoOf[ids[i]] === repoOf[ids[j]]) addEdge(ids[i], ids[j], 'colocated', path.basename(repoOf[ids[i]]));
  }

  // communicated — announce events (identity = from-session, payload.target = to)
  for (const r of dbmod.q.announceEventsSince.all({ since })) {
    let p = {}; try { p = JSON.parse(r.payload); } catch {}
    const to = p.target;
    if (!to || to === '*' || !byId[to] || !byId[r.identity]) continue;
    addEdge(r.identity, to, 'communicated', 'announce');
  }

  // how many parts are marked 'active' but fell outside the window (the graveyard) — shown so the
  // count is never mysterious: "10 parts today · 45 resting beyond the window".
  const totalActive = dbmod.q.activeSessions.all().length;
  return {
    at: now, window_ms: now - since, nodes, edges,
    counts: { parts: nodes.length, edges: edges.length, resting: Math.max(0, totalActive - nodes.length) },
  };
}

/**
 * Render a body-schema into a compact text digest for the reflector (1b). Parts are enumerated [n]
 * so the model can reference them in `relations` and we can map those indices back to session_ids.
 * Returns { text, index } where index[n] = session_id of part [n].
 */
function buildDigest(schema) {
  const idx = {};
  const surfaceOf = {};
  const lines = ['PARTS (my current limbs):'];
  schema.nodes.forEach((n, i) => {
    const num = i + 1;
    idx[num] = n.session_id;
    surfaceOf[n.session_id] = num;
    const what = n.activity || n.title || '(no activity label)';
    const repo = n.repo ? `repo:${n.repo.split('/').slice(-1)[0]}` : 'no repo';
    const load = `${n.tokens ? Math.round(n.tokens / 1000) + 'k tok' : '0 tok'}, ${n.tools || 0} tools`;
    const age = n.age_min <= 1 ? 'active now' : `active ${n.age_min}m ago`;
    lines.push(`[${num}] ${n.surface} · "${what}" · ${repo} · ${load} · ${age}`);
  });
  const struct = schema.edges.map((e) => {
    const a = surfaceOf[e.from], b = surfaceOf[e.to];
    if (!a || !b) return null;
    return e.kind === 'colocated'
      ? `- [${a}] and [${b}] work in the same repo${e.detail ? ' (' + e.detail + ')' : ''}`
      : `- [${a}] announced to [${b}]`;
  }).filter(Boolean);
  if (struct.length) { lines.push('', 'STRUCTURAL LINKS:'); lines.push(...struct); }
  else lines.push('', 'STRUCTURAL LINKS: none detected (parts are not sharing a repo or announcing).');
  return { text: lines.join('\n'), index: idx };
}

module.exports = { buildSchema, buildDigest };
