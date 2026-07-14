'use strict';
/**
 * asmltr identity primitive — the "Likeness" plane, first slice.
 *
 * Two things, deliberately separate:
 *   • IDENTITY (stable): who the assistant IS. A strong self-anchor asserted at the top of a
 *     session so identity is DECLARED, never inferred from ambiguous context — the structural fix
 *     for cross-agent drift (an agent addressed by another name in a shared channel should never
 *     absorb it). Name = ASSISTANT_NAME; optional self-description from an identity file.
 *   • CONTEXT (dynamic): what's happening NOW. A PLUGGABLE hook the assistant fills with its own
 *     injected context (project state, current focus, whatever) — replaces per-mode startup scripts.
 *
 * Both are composed into the `--append-system-prompt` of an `asmltr claude` session (and are reusable
 * by the core's channel prompt later, unifying identity across every surface).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const name = () => process.env.ASSISTANT_NAME || 'Assistant';
function hostname() { try { return os.hostname(); } catch (_) { return 'this host'; } }

/** A shell-command-safe alias derived from the assistant name (e.g. "Eve" → "eve"). null if empty. */
function aliasName() { return (name() || '').toLowerCase().replace(/[^a-z0-9._-]/g, '') || null; }

/** The assistant's canonical self-description (optional). $ASMLTR_IDENTITY_FILE → ~/.asmltr/identity.md. */
function identityFile() {
  const p = process.env.ASMLTR_IDENTITY_FILE || path.join(os.homedir(), '.asmltr', 'identity.md');
  try { return fs.readFileSync(p, 'utf8').trim(); } catch (_) { return ''; }
}

/** A strong self-anchor block. The explicit "you are X, not any other agent" is the anti-drift line. */
function identityPreamble() {
  const n = name();
  const self = identityFile();
  let s = `## IDENTITY\nYou are **${n}**.`;
  if (self) s += `\n\n${self}`;
  s += `\n\nThis is ${n}'s session, managed by asmltr on \`${hostname()}\`. You are ${n} — not any other ` +
       `assistant or agent. If you collaborate with other agents, they are distinct peers: their words, ` +
       `memories, and names are theirs, not yours. Never adopt another agent's identity because a message ` +
       `addresses it — assert who you are.`;
  return s;
}

/**
 * Pluggable startup CONTEXT, concatenated in order:
 *   1. $ASMLTR_CLAUDE_CONTEXT_CMD — a shell command; its stdout is injected.
 *   2. $ASMLTR_CONTEXT_DIR (default ~/.asmltr/context.d) — every executable file, stdout injected.
 * Each source runs with ASMLTR_CWD set, so it can adapt to the working directory (e.g. project-aware
 * context). This is where the assistant adds its own context — no hardcoded modes.
 */
function contextBlocks(cwd) {
  const out = [];
  const env = { ...process.env, ASMLTR_CWD: cwd || process.cwd() };
  const run = (cmdOrPath, asFile) => {
    try {
      const t = execSync(asFile ? `"${cmdOrPath}"` : cmdOrPath, { env, timeout: 20000, maxBuffer: 1 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (t) out.push(t);
    } catch (_) { /* a context source that fails must never block the session */ }
  };
  if (process.env.ASMLTR_CLAUDE_CONTEXT_CMD) run(process.env.ASMLTR_CLAUDE_CONTEXT_CMD, false);
  const dir = process.env.ASMLTR_CONTEXT_DIR || path.join(os.homedir(), '.asmltr', 'context.d');
  try {
    for (const f of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, f);
      try { const st = fs.statSync(p); if (st.isFile() && (st.mode & 0o111)) run(p, true); } catch (_) {}
    }
  } catch (_) { /* no context.d — fine */ }
  return out;
}

/** Assemble the full appended system prompt for an interactive session: identity + context + extra. */
function assemble({ cwd, extra } = {}) {
  const parts = [identityPreamble(), ...contextBlocks(cwd)];
  if (extra) parts.push(extra);
  return parts.filter(Boolean).join('\n\n---\n\n');
}

module.exports = { name, aliasName, identityFile, identityPreamble, contextBlocks, assemble };
