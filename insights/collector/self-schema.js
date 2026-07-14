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
  since = since || Date.now() - 45 * 60000;
  // The LIVE body — parts that ACTED within the window, not every session ever marked 'active'
  // (status stays 'active' forever, so the raw list is a graveyard). Proprioception is the present.
  const sessions = dbmod.q.activeSessions.all().filter((s) => (s.last_activity_unix || 0) > since);
  const byId = {}; for (const s of sessions) byId[s.session_id] = s;

  const nodes = sessions.map((s) => ({
    session_id: s.session_id, surface: s.surface, title: s.title || null, activity: s.activity || null,
    working_dir: s.working_dir || null, status: s.status, tokens: s.tokens_total || 0, tools: s.tool_count || 0,
    last_activity_unix: s.last_activity_unix || 0,
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

  return { at: Date.now(), nodes, edges, counts: { parts: nodes.length, edges: edges.length } };
}

module.exports = { buildSchema };
