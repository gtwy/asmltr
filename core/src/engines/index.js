'use strict';
/**
 * Engine dispatch — maps an engine id to its implementation, loaded LAZILY so the core only pulls in
 * the code (and heavy deps, like the Claude SDK) for engines it actually runs. A Gemini-only or
 * Codex-only install therefore never loads the Claude SDK.
 *
 * Every engine implements the same contract:
 *   runTurn(opts) → { text, segments, engineSessionId, tools, usage, isError }
 *   complete({prompt, model}) → string        (cheap one-shot for the title/status/assessment labelers)
 *   cheapModel : string                       (default model for the labelers)
 *   getLastModel() → string|null
 */
const registry = require('../../../shared/engines');
const CACHE = {};

function get(id) {
  const key = registry.known(id) ? id : 'claude';
  if (!CACHE[key]) {
    if (key === 'gemini') CACHE[key] = require('./gemini');
    else if (key === 'codex') CACHE[key] = require('./codex');
    else CACHE[key] = require('./claude');
  }
  return CACHE[key];
}

/** The engine a turn should run on: explicit override → the configured default. */
function resolve(engineId) { return get(engineId || registry.getDefault()); }

module.exports = { get, resolve };
