'use strict';
/**
 * Self-silo conversation transcripts — the write path for memory/transcripts (seeded by the
 * `self` template, previously unwired). Every local ask/grok turn appends here so a fresh
 * engine session after idle can rehydrate via `asmltr silo get` / `silo find` without
 * grepping events-*.jsonl or ~/.grok/sessions.
 *
 * Layout (silo-relative):
 *   memory/transcripts/<conversation-key>.md   append-only user+assistant turns
 *   memory/last-topics.md                      short newest-first index (easy first read)
 */
const fs = require('fs');
const path = require('path');
const silo = require('./silo');

const LAST_TOPICS_REL = 'memory/last-topics.md';
const TRANSCRIPTS_REL = 'memory/transcripts';
const LAST_TOPICS_KEEP = 20;
const USER_CLIP = 16000;
const ASSISTANT_CLIP = 32000;
const TOPIC_CLIP = 160;

function clip(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '\n…' : s;
}

function oneLine(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/** Filesystem-safe conversation_key (colons etc. → dashes). */
function safeKey(key) {
  return String(key || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'unknown';
}

function formatTurn({ ts, conversationKey, channel, userText, assistantText }) {
  const iso = new Date(Number.isFinite(ts) ? ts : Date.now()).toISOString();
  const key = String(conversationKey || 'unknown');
  const ch = channel ? `  channel=${channel}` : '';
  return `## ${iso}  ${key}${ch}\n\n` +
    `**user:** ${clip(userText, USER_CLIP)}\n\n` +
    `**assistant:** ${clip(assistantText, ASSISTANT_CLIP)}\n\n`;
}

function lastTopicsPath() {
  return path.join(silo.selfSub('memory'), 'last-topics.md');
}

function transcriptAbs(conversationKey) {
  return path.join(silo.selfSub(TRANSCRIPTS_REL), safeKey(conversationKey) + '.md');
}

function updateLastTopics({ ts, conversationKey, userText }) {
  const iso = new Date(Number.isFinite(ts) ? ts : Date.now()).toISOString();
  const key = String(conversationKey || 'unknown');
  const line = `- ${iso.slice(0, 16)}Z [${key}] ${oneLine(userText).slice(0, TOPIC_CLIP)}`;
  const p = lastTopicsPath();
  let existing = [];
  try {
    existing = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.startsWith('- '));
  } catch (_) {}
  existing.unshift(line);
  const body = '# Last topics\n\n' +
    'Newest first. Full turns live under `memory/transcripts/`.\n\n' +
    existing.slice(0, LAST_TOPICS_KEEP).join('\n') + '\n';
  fs.writeFileSync(p, body);
  return LAST_TOPICS_REL;
}

/**
 * Append one user+assistant turn to the Self silo. Returns silo-relative paths
 * (no secrets). `ts` is caller-supplied so tests stay free of wall-clock coupling.
 */
function appendTurn({ conversationKey, channel, userText, assistantText, ts } = {}) {
  const t = Number.isFinite(ts) ? ts : Date.now();
  const key = conversationKey || 'unknown';
  const abs = transcriptAbs(key);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.appendFileSync(abs, formatTurn({ ts: t, conversationKey: key, channel, userText, assistantText }));
  updateLastTopics({ ts: t, conversationKey: key, userText });
  return {
    transcript: `${TRANSCRIPTS_REL}/${safeKey(key)}.md`,
    lastTopics: LAST_TOPICS_REL,
  };
}

module.exports = {
  appendTurn, formatTurn, safeKey, lastTopicsPath, transcriptAbs,
  LAST_TOPICS_REL, TRANSCRIPTS_REL, LAST_TOPICS_KEEP,
};
