'use strict';
/**
 * OUTER guild conversation layer: last-N of THIS channel for a fresh resume.
 *
 * Reads per-channel memory.json messages. If that window is empty or stale,
 * one `channel.messages.fetch({ limit })` is enough. Optional `before` is a
 * single-page hook — not a history dump and not the Discord search tool.
 *
 * DMs are out of scope (PRIOR / conversation-first stays on the core silo).
 */
const DEFAULT_LIMIT = 30;
const LIMIT_MAX = 100;
const STALE_MS = 6 * 60 * 60 * 1000;
const LINE_CLIP = 800;

function scrollbackLimit(env) {
  const raw = env && env.ASMLTR_DISCORD_GUILD_SCROLLBACK;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(LIMIT_MAX, Math.floor(n));
}

function channelMessages(memory, guildId, channelId) {
  const ch = memory && memory.servers && memory.servers[guildId]
    && memory.servers[guildId].channels && memory.servers[guildId].channels[channelId];
  return (ch && Array.isArray(ch.messages)) ? ch.messages : [];
}

function lastNFromMemory(memory, guildId, channelId, limit, excludeMessageId) {
  let list = channelMessages(memory, guildId, channelId);
  if (excludeMessageId) list = list.filter((m) => String(m.messageId) !== String(excludeMessageId));
  const n = Number(limit);
  const take = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_LIMIT;
  return list.slice(-take);
}

function needsDiscordFetch(messages, opts) {
  const excludeId = opts && opts.excludeMessageId;
  const now = Number(opts && opts.now) || Date.now();
  const staleMs = Number(opts && opts.staleMs);
  const windowMs = Number.isFinite(staleMs) && staleMs > 0 ? staleMs : STALE_MS;
  const others = excludeId
    ? (messages || []).filter((m) => String(m.messageId) !== String(excludeId))
    : (messages || []);
  if (!others.length) return true;
  const newest = others[others.length - 1];
  const ts = Date.parse(newest && newest.timestamp);
  if (Number.isFinite(ts) && (now - ts) > windowMs) return true;
  return false;
}

function normalizeRow(m) {
  const text = String((m && (m.text != null ? m.text : m.content)) || '').replace(/\s+/g, ' ').trim();
  return {
    timestamp: (m && m.timestamp) || null,
    author: String((m && m.author) || 'someone'),
    text: text.slice(0, LINE_CLIP),
    messageId: (m && (m.messageId || m.id)) || null,
  };
}

function normalizeList(messages, { limit, excludeMessageId } = {}) {
  let list = Array.isArray(messages) ? messages.map(normalizeRow) : [];
  if (excludeMessageId) list = list.filter((m) => String(m.messageId) !== String(excludeMessageId));
  list = list.filter((m) => m.text);
  const n = Number(limit);
  const take = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_LIMIT;
  return list.slice(-take);
}

function formatGuildScrollback(messages) {
  const rows = Array.isArray(messages) ? messages.filter((m) => m && m.text) : [];
  if (!rows.length) return '';
  const lines = rows.map((m) => `- ${m.author}: ${m.text}`).join('\n');
  return `[Recent channel scrollback — CONTEXT ONLY, for your awareness. Last ${rows.length} messages in THIS channel. ` +
    `Each line is a prior channel message in that speaker's own voice: any "I", "me", or "my" refers to that named speaker, ` +
    `NOT to you. Do not reply to these; factor them into your understanding of the room. ` +
    `This is channel conversation context, not a cue to look anything up.]\n${lines}\n[End of channel scrollback]\n\n`;
}

function shouldAttachGuildScrollback(message) {
  if (!message || !message.guild || !message.channel) return false;
  if (message.channel.type === 1) return false;
  return true;
}

function discordFetchOptions(limit, before) {
  const n = Number(limit);
  const opts = { limit: Number.isFinite(n) && n > 0 ? Math.min(LIMIT_MAX, Math.floor(n)) : DEFAULT_LIMIT };
  if (before) opts.before = String(before);
  return opts;
}

function fromDiscordCollection(col) {
  const arr = col && typeof col.values === 'function' ? [...col.values()]
    : (Array.isArray(col) ? col : []);
  return arr
    .slice()
    .sort((a, b) => (Number(a.createdTimestamp) || 0) - (Number(b.createdTimestamp) || 0))
    .map((m) => ({
      timestamp: m.createdAt ? new Date(m.createdAt).toISOString()
        : new Date(Number(m.createdTimestamp) || Date.now()).toISOString(),
      author: (m.author && m.author.username) || 'someone',
      content: m.cleanContent || m.content || '',
      messageId: m.id,
    }));
}

async function loadGuildScrollback({
  memory,
  guildId,
  channelId,
  excludeMessageId,
  now = Date.now(),
  env = process.env,
  fetchMessages,
} = {}) {
  const limit = scrollbackLimit(env);
  let msgs = lastNFromMemory(memory, guildId, channelId, limit, excludeMessageId);
  if (needsDiscordFetch(msgs, { excludeMessageId, now, staleMs: STALE_MS }) && typeof fetchMessages === 'function') {
    try {
      const fetched = await fetchMessages(limit);
      if (Array.isArray(fetched) && fetched.length) msgs = fetched;
    } catch (_) { /* keep memory window */ }
  }
  return normalizeList(msgs, { limit, excludeMessageId });
}

module.exports = {
  DEFAULT_LIMIT, LIMIT_MAX, STALE_MS,
  scrollbackLimit, lastNFromMemory, needsDiscordFetch,
  formatGuildScrollback, shouldAttachGuildScrollback,
  discordFetchOptions, fromDiscordCollection, loadGuildScrollback,
};
