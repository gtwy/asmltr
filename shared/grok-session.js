'use strict';
/**
 * Grok session model — which model a grok turn ACTUALLY ran on, for the usage log and pricing.
 *
 * `-m` is only a request. grok 1.0.41 `grok agent … stdio` resets a new ACP session to xAI's
 * server-side default_model at session/new, so the configured model (engines.json) can differ
 * from the one that answered. The grok CLI records the truth in its session files:
 *   <GROK_HOME or ~/.grok>/sessions/<encodeURIComponent(cwd)>/<sessionId>/summary.json
 *     → current_model_id
 * Headless streaming-json also reports it on the final `end` event (`modelUsage` keys, e.g.
 * `grok-4.6-build`), and ACP reports it in the session/new (or set_config_option) result.
 *
 * Every reader returns a normalized model id or null. null means "unknown": the caller falls
 * back to the configured model. Pure, synchronous, never throws.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function grokHome(env = process.env) {
  const h = env.GROK_HOME && String(env.GROK_HOME).trim();
  return h || path.join(os.homedir(), '.grok');
}

/** `grok-4.6-build` (the CLI's internal build variant in modelUsage) → `grok-4.6`. Anything else as-is. */
function normalizeModelId(id) {
  if (id == null) return null;
  const s = String(id).trim();
  if (!s) return null;
  const m = /^(grok-\d[\w.]*)-build$/i.exec(s);
  return m ? m[1] : s;
}

function readCurrentModel(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return normalizeModelId(j && (j.current_model_id || j.primaryModelId));
  } catch (_) { return null; }
}

/**
 * current_model_id from the grok session's summary.json. Looks under the session's cwd first,
 * then scans the other cwd folders (a session id is unique across them). null if not found.
 */
function sessionModelId(sessionId, cwd, env = process.env) {
  const sid = sessionId == null ? '' : String(sessionId).trim();
  if (!SESSION_ID_RE.test(sid)) return null;
  const root = path.join(grokHome(env), 'sessions');
  if (cwd) {
    const hit = readCurrentModel(path.join(root, encodeURIComponent(String(cwd)), sid, 'summary.json'));
    if (hit) return hit;
  }
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch (_) { return null; }
  for (const d of dirs) {
    const f = path.join(root, d, sid, 'summary.json');
    if (!fs.existsSync(f)) continue;
    const hit = readCurrentModel(f);
    if (hit) return hit;
  }
  return null;
}

/** Headless streaming-json `end` event → model id from `modelUsage` (the key with most output tokens). */
function modelFromEnd(ev) {
  const mu = ev && typeof ev === 'object' && ev.modelUsage;
  if (!mu || typeof mu !== 'object') return null;
  let best = null; let bestOut = -1;
  for (const [k, v] of Object.entries(mu)) {
    const out = Number(v && (v.outputTokens || v.output_tokens)) || 0;
    if (out > bestOut) { best = k; bestOut = out; }
  }
  return normalizeModelId(best);
}

/**
 * ACP session/new or session/set_config_option result → model id.
 * Order: configOptions `model` currentValue, models.currentModelId, currentModelId, modelId.
 */
function acpResultModelId(result) {
  if (!result || typeof result !== 'object') return null;
  if (Array.isArray(result.configOptions)) {
    const opt = result.configOptions.find((c) => c && c.id === 'model');
    const v = opt && normalizeModelId(opt.currentValue);
    if (v) return v;
  }
  const models = result.models && typeof result.models === 'object' ? result.models : null;
  return normalizeModelId((models && models.currentModelId) || result.currentModelId || result.modelId);
}

module.exports = { grokHome, normalizeModelId, sessionModelId, modelFromEnd, acpResultModelId, SESSION_ID_RE };
