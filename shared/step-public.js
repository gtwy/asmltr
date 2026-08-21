'use strict';
/**
 * Public Discord live-step helpers (stream_steps).
 *
 * Not Grok-gated. Discord posts whatever the core forwards as onThinking /
 * onTool. Claude already emits thinking blocks; Grok/Gemini/Codex do too when
 * they think. If the engine sends no thinking, onThinking never fires and
 * these helpers stay idle — a Claude-only install is unchanged except that
 * extended-thinking turns may get sanitized 💭 chips (same shape as narration
 * -# steps this connector already posts).
 *
 * Sanitize/drop is Discord DISPLAY only. Core, collector, and Live keep
 * full-fidelity thoughts. Email does not get thought chips.
 * Leaky bubbles are dropped whole. Generic patterns only — no name denylist
 * in git. Speaker tokens (username / display name) and Access principal
 * ids / display names / mailboxes are passed at runtime and never hardcoded.
 *
 * Thought volume: xhigh uncapped. high and medium → 2 💭 chips (public and DM).
 * Below medium (low) → 0: no chips, just the answer.
 * Tool / Working / Still working chips are xhigh only. medium/high are 💭 only.
 */

const { redactSecrets } = require('./redact');

const ACP_TYPE = /^(tool_call|tool_call_update|tool_use|function_call)$/i;
const THINK_HEARTBEAT_MS = 45000;
const WORKING_LINE = '-# Working';
const STILL_WORKING_LINE = '-# Still working';
const THOUGHT_CLAMP = 280;

function looksLikePromptRestatement(text) {
  const s = String(text || '');
  if (!s.trim()) return false;
  if (/CURRENT SPEAKER/i.test(s)) return true;
  if (/\bidentity\.md\b/i.test(s)) return true;
  if (/\bCLAUDE\.md\b/i.test(s)) return true;
  if (/\/home\/[A-Za-z0-9._-]+/.test(s)) return true;
  if (/\bThe user is\b/i.test(s)) return true;
  if (/This is a Discord message/i.test(s)) return true;
  if (/I was @-mentioned/i.test(s)) return true;
  if (/\basking me \(/i.test(s)) return true;
  return false;
}

function looksLikePromptLeak(text) {
  const s = String(text || '');
  if (looksLikePromptRestatement(s)) return true;
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(s)) return true;
  return false;
}

function escapeRe(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Username / display-name tokens from the live message. Skip tiny tokens. */
function speakerHintsFrom(author, member) {
  const out = [];
  const add = (raw) => {
    const s = String(raw || '').trim();
    if (s.length >= 4 && !/^\d+$/.test(s)) out.push(s);
    for (const p of s.split(/[\s._-]+/)) {
      if (p.length >= 4 && !/^\d+$/.test(p)) out.push(p);
    }
  };
  if (author && typeof author === 'object') {
    add(author.username);
    add(author.globalName);
    add(author.displayName);
    add(author.raw_username);
  } else if (typeof author === 'string') {
    add(author);
  }
  if (member && typeof member === 'object') {
    add(member.displayName);
    add(member.nickname);
  }
  return [...new Set(out)];
}

function mentionsSpeaker(text, hints) {
  const s = String(text || '');
  for (const h of hints || []) {
    if (!h || String(h).length < 4) continue;
    if (new RegExp('\\b' + escapeRe(h) + '\\b', 'i').test(s)) return true;
  }
  return false;
}

/**
 * Access principal tokens at runtime: id (`fixture-person` → also `person`),
 * display name (`Ada Lovelace` → also `Lovelace`), non-numeric identifiers.
 * Emails stay whole (no `.com` split). Skip `self` so "myself" thoughts survive.
 */
function identityHintsFrom(records) {
  const out = [];
  const addName = (raw) => {
    const s = String(raw || '').trim();
    if (s.length < 4 || /^\d+$/.test(s)) return;
    out.push(s);
    for (const p of s.split(/[\s._-]+/)) {
      if (p.length >= 4 && !/^\d+$/.test(p)) out.push(p);
    }
  };
  for (const rec of records || []) {
    if (!rec || rec.id === 'self') continue;
    addName(rec.id);
    addName(rec.display_name);
    for (const ident of rec.identifiers || []) {
      const v = ident && ident.value != null ? String(ident.value).trim() : '';
      if (!v || /^\d+$/.test(v)) continue;
      if (/@/.test(v)) { if (v.length >= 4) out.push(v); continue; }
      addName(v);
    }
  }
  return [...new Set(out)];
}

/**
 * Final Discord reply after streaming. Public guild: never fall back to the
 * raw reply if the held segment was dropped as a leak, and drop answers that
 * name Access identities. DMs keep the raw reply. Vendor emails not in Access
 * still post.
 */
function pickPublicReply({ pending, replyText, leakDropped, publicSurface, hints }) {
  const held = String(pending || '').trim();
  if (held) {
    if (publicSurface && mentionsSpeaker(held, hints)) return '';
    return held;
  }
  const raw = String(replyText || '').trim();
  if (!raw) return '';
  if (!publicSurface) return raw;
  if (leakDropped) return '';
  if (looksLikePromptRestatement(raw) || mentionsSpeaker(raw, hints)) return '';
  return raw;
}

/** How many 💭 chips to post. Infinity = no cap. 0 = none (go straight to the answer). */
function thoughtBudget(effort) {
  const e = String(effort || 'medium').toLowerCase();
  if (e === 'xhigh') return Infinity;
  if (e === 'high' || e === 'medium') return 2;
  return 0;
}

function toolTitle(tool) {
  const raw = typeof tool === 'string'
    ? tool
    : (tool && (tool.name || tool.title || tool.kind)) || '';
  const s = String(raw || '').trim();
  if (!s || ACP_TYPE.test(s)) return '';
  if (/[\\/]/.test(s)) return '';
  const first = s.split(/[\s.:]+/)[0];
  return first.slice(0, 40);
}

function humanToolChip(tool) {
  const t = toolTitle(tool).toLowerCase();
  if (/^(read|read_file|readfile|cat|open)$/.test(t)) return 'Reading a file';
  if (/^(bash|shell|run|exec|command|sh)$/.test(t)) return 'Running a command';
  if (/(web|lookup|browse|fetch|http)/.test(t)) return 'Looking something up';
  if (/^(search|grep|glob|find|rg)$/.test(t)) return 'Searching';
  return 'Working';
}

function discordToolLine(streamTools, tool) {
  if (streamTools) {
    const title = toolTitle(tool);
    return `-# 🔧 \`${title || 'Working'}\``;
  }
  return `-# ${humanToolChip(tool)}`;
}

/**
 * Email/MCP must never send Discord thought chips or grok thought preambles.
 * Discord keeps 💭 via discordThoughtLine. This is DISPLAY for quiet surfaces.
 */
function stripThoughtChrome(text) {
  let s = String(text || '');
  s = s.split('\n').filter((l) => {
    const t = l.trim();
    if (!t) return true;
    if (/^💭/.test(t)) return false;
    if (/^-#(\s|$)/.test(t)) return false;
    return true;
  }).join('\n').trim();
  const cut = s.match(/I['’]ll answer the thread directly\.?/i);
  if (cut) {
    const after = s.slice(cut.index + cut[0].length).replace(/^\s+/, '');
    if (after.length > 20) s = after;
  }
  const paras = s.split(/\n\n+/);
  if (paras.length >= 2) {
    const head = paras[0];
    if (looksLikePromptLeak(head)
      || /not an ops-desk alert/i.test(head)
      || /^(the user|james) asked\b/i.test(head)) {
      s = paras.slice(1).join('\n\n').trim();
    }
  }
  return s;
}

/** Last narration block, with thought chrome removed. Email/MCP reply body. */
function quietReplyFromResult(result) {
  const segs = ((result && result.segments) || [])
    .map((x) => String(x || '').trim()).filter(Boolean);
  const text = segs.length ? segs[segs.length - 1] : String((result && result.text) || '');
  return stripThoughtChrome(text);
}

/** Sanitized Discord thought chip, or '' to drop. Never raw text. */
function discordThoughtLine(text, hints) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  if (looksLikePromptLeak(raw) || mentionsSpeaker(raw, hints)) return '';
  const cleaned = String(redactSecrets(raw).text || '').trim();
  if (!cleaned || looksLikePromptLeak(cleaned) || mentionsSpeaker(cleaned, hints)) return '';
  let body = cleaned.replace(/\s+/g, ' ');
  if (body.length > THOUGHT_CLAMP) body = body.slice(0, THOUGHT_CLAMP - 1) + '…';
  return `-# 💭 ${body}`;
}

module.exports = {
  looksLikePromptLeak, looksLikePromptRestatement, toolTitle, humanToolChip, discordToolLine, discordThoughtLine,
  speakerHintsFrom, mentionsSpeaker, identityHintsFrom, pickPublicReply, thoughtBudget,
  stripThoughtChrome, quietReplyFromResult,
  THINK_HEARTBEAT_MS, WORKING_LINE, STILL_WORKING_LINE, THOUGHT_CLAMP,
};
