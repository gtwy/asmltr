'use strict';
/**
 * Discord Ctrl+F — official guild search + a capped around-hop.
 *
 * Guild: GET /guilds/{guild.id}/messages/search (does not dump channel history).
 * Context: GET /channels/{id}/messages?around=hit&limit=N with N ≤ 25.
 * DMs: capped around/before on the DM channel id — never guild search, never a full dump.
 * Bot/self messages stay in the result (do not filter them out).
 *
 * Official guild search does not fold accents. We expand each query into a
 * small variant set (NFD-stripped + common Spanish recombinations) and merge
 * hits by message id so `padron` / `pilon anejo` still find accented posts.
 */
const { looksLikeSnowflake } = require('./discord-targets');

const AROUND_LIMIT_MAX = 25;
const SEARCH_LIMIT_MAX = 25;
const DEFAULT_AROUND_LIMIT = 8;
const DEFAULT_SEARCH_LIMIT = 5;
const QUERY_VARIANT_MAX = 8;
const ACUTE = { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú' };
const TILDE_N = { n: 'ñ', N: 'Ñ' };
const INDEX_NOT_READY_CODE = 110000;
const INDEX_RETRY_FALLBACK_MS = 1000;
const MAX_INDEX_RETRIES = 3;
const CONTENT_MAX = 1024;

function capLimit(n, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(max, Math.floor(v));
}

function capAroundLimit(n) {
  return capLimit(n, AROUND_LIMIT_MAX, DEFAULT_AROUND_LIMIT);
}

function capSearchLimit(n) {
  return capLimit(n, SEARCH_LIMIT_MAX, DEFAULT_SEARCH_LIMIT);
}

function foldAccents(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC');
}

function collapseWs(s) {
  return String(s || '').trim().replace(/\s+/g, ' ');
}

function replaceLastMapped(word, map) {
  const w = String(word || '');
  for (let i = w.length - 1; i >= 0; i--) {
    const next = map[w[i]];
    if (next) return w.slice(0, i) + next + w.slice(i + 1);
  }
  return w;
}

function lastVowelAcute(word) {
  return replaceLastMapped(word, ACUTE);
}

function lastNTilde(word) {
  return replaceLastMapped(word, TILDE_N);
}

function spanishWordVariant(word) {
  const folded = foldAccents(word);
  if (/[aeiouAEIOU]n$/i.test(folded)) return lastVowelAcute(folded);
  if (/n/i.test(folded)) return lastNTilde(folded);
  return lastVowelAcute(folded);
}

function mapWords(query, fn) {
  return String(query).split(/\s+/).filter(Boolean).map(fn).join(' ');
}

function expandQueryVariants(query) {
  const orig = collapseWs(query);
  if (!orig) return [];
  const folded = foldAccents(orig);
  const out = [];
  const add = (s) => {
    const v = collapseWs(s);
    if (v && !out.includes(v)) out.push(v);
  };
  add(orig);
  add(folded);
  add(mapWords(folded, lastVowelAcute));
  add(mapWords(folded, lastNTilde));
  add(mapWords(folded, spanishWordVariant));
  return out.slice(0, QUERY_VARIANT_MAX);
}

function hitMessageId(hit) {
  if (!hit) return '';
  if (hit.message && hit.message.id != null) return String(hit.message.id);
  if (hit.id != null) return String(hit.id);
  return '';
}

function mergeHitsByMessageId(groups, limit) {
  const lists = Array.isArray(groups) ? groups.map((g) => (Array.isArray(g) ? g : [])) : [];
  const cap = limit == null ? Infinity : Math.max(0, Number(limit) || 0);
  const seen = new Set();
  const out = [];
  const idxs = lists.map(() => 0);
  let progress = true;
  while (progress && out.length < cap) {
    progress = false;
    for (let g = 0; g < lists.length; g++) {
      while (idxs[g] < lists[g].length) {
        const hit = lists[g][idxs[g]++];
        const id = hitMessageId(hit);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(hit);
        progress = true;
        break;
      }
      if (out.length >= cap) break;
    }
  }
  return out;
}

function snowflakeOrThrow(id, label) {
  const s = String(id || '').trim();
  if (!looksLikeSnowflake(s)) throw new Error(label + ' must be a Discord snowflake');
  return s;
}

function buildGuildSearchPath(guildId, params) {
  const gid = snowflakeOrThrow(guildId, 'guild id');
  const q = new URLSearchParams();
  const content = String((params && params.content) || '').trim().slice(0, CONTENT_MAX);
  if (content) q.set('content', content);
  q.set('limit', String(capSearchLimit(params && params.limit)));
  const ids = []
    .concat((params && params.channelIds) || [])
    .concat((params && params.channelId) ? [params.channelId] : [])
    .map(String)
    .filter(looksLikeSnowflake);
  for (const id of ids) q.append('channel_id', id);
  if (params && params.offset != null) q.set('offset', String(Math.max(0, Number(params.offset) || 0)));
  return '/guilds/' + gid + '/messages/search?' + q.toString();
}

function buildAroundPath(channelId, messageId, limit) {
  const cid = snowflakeOrThrow(channelId, 'channel id');
  const mid = snowflakeOrThrow(messageId, 'message id');
  return '/channels/' + cid + '/messages?around=' + mid + '&limit=' + capAroundLimit(limit);
}

function buildDmMessagesPath({ channelId, around, before, after, limit }) {
  const cid = snowflakeOrThrow(channelId, 'DM channel id');
  const q = new URLSearchParams();
  if (around) q.set('around', snowflakeOrThrow(around, 'around'));
  else if (before) q.set('before', snowflakeOrThrow(before, 'before'));
  else if (after) q.set('after', snowflakeOrThrow(after, 'after'));
  q.set('limit', String(capAroundLimit(limit)));
  return '/channels/' + cid + '/messages?' + q.toString();
}

function isIndexNotReady(status, body) {
  if (Number(status) === 202) return true;
  const code = body && body.code;
  return Number(code) === INDEX_NOT_READY_CODE;
}

function retryAfterMs(body) {
  const sec = body && body.retry_after;
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return INDEX_RETRY_FALLBACK_MS;
  return Math.round(n * 1000);
}

function flattenHits(body) {
  const rows = (body && body.messages) || [];
  const out = [];
  for (const inner of rows) {
    const list = Array.isArray(inner) ? inner : [inner];
    // Official search used to nest surrounding context; that is no longer returned.
    // Keep every message in the inner array — including bot/self.
    for (const m of list) {
      if (m && m.id) out.push(m);
    }
  }
  return out;
}

function normalizeMessage(m) {
  if (!m) return null;
  const author = m.author || {};
  return {
    id: String(m.id),
    channel_id: m.channel_id != null ? String(m.channel_id) : '',
    guild_id: m.guild_id != null ? String(m.guild_id) : '',
    content: m.content != null ? String(m.content) : '',
    timestamp: m.timestamp || '',
    author: {
      id: author.id != null ? String(author.id) : '',
      username: author.username || author.global_name || '',
      bot: !!author.bot,
    },
  };
}

async function sleepMs(ms, sleep) {
  const fn = typeof sleep === 'function' ? sleep : (n) => new Promise((r) => setTimeout(r, n));
  await fn(ms);
}

async function requestWithIndexRetry(request, path, sleep) {
  let last = { status: 0, body: {} };
  for (let i = 0; i < MAX_INDEX_RETRIES; i++) {
    last = await request(path);
    const status = last && last.status;
    const body = (last && last.body) || {};
    if (!isIndexNotReady(status, body)) return last;
    if (i + 1 >= MAX_INDEX_RETRIES) {
      return { status, body, indexNotReady: true };
    }
    await sleepMs(Math.min(retryAfterMs(body), 5000), sleep);
  }
  return last;
}

function aroundMessages(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.messages) && !Array.isArray(body.messages[0])) return body.messages;
  return flattenHits(body);
}

async function fetchAround(request, channelId, messageId, limit) {
  if (!channelId || !messageId) return [];
  try {
    const r = await request(buildAroundPath(channelId, messageId, limit));
    if (!r || r.status >= 300) return [];
    return aroundMessages(r.body).map(normalizeMessage).filter(Boolean);
  } catch (_) {
    return [];
  }
}

async function searchGuilds({ request, guildIds, query, channelIds, aroundLimit, sleep } = {}) {
  if (typeof request !== 'function') throw new Error('request required');
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'query required' };
  const ids = (guildIds || []).map(String).filter(looksLikeSnowflake);
  if (!ids.length) return { ok: false, error: 'no guilds' };
  const around = capAroundLimit(aroundLimit);
  const variants = expandQueryVariants(q);
  const hits = [];
  let indexNotReady = false;
  let retryAfter = 0;
  for (const guildId of ids) {
    const groups = [];
    for (const variant of variants) {
      const path = buildGuildSearchPath(guildId, { content: variant, channelIds, limit: SEARCH_LIMIT_MAX });
      const r = await requestWithIndexRetry(request, path, sleep);
      if (r && r.indexNotReady) {
        indexNotReady = true;
        retryAfter = Math.max(retryAfter, retryAfterMs(r.body));
        groups.push([]);
        continue;
      }
      if (!r || r.status >= 300) {
        groups.push([]);
        continue;
      }
      const row = [];
      for (const raw of flattenHits(r.body)) {
        const message = normalizeMessage(raw);
        if (!message) continue;
        row.push({ guildId, message });
      }
      groups.push(row);
    }
    for (const hit of mergeHitsByMessageId(groups, SEARCH_LIMIT_MAX)) {
      const message = hit.message;
      const context = await fetchAround(request, message.channel_id, message.id, around);
      hits.push({ guildId, message, context: context.length ? context : [message] });
    }
  }
  if (!hits.length && indexNotReady) {
    return { ok: false, indexNotReady: true, retryAfter: Math.round(retryAfter / 1000) || 1, hits: [] };
  }
  return { ok: true, indexNotReady: false, hits, total: hits.length };
}

async function searchDm({ request, channelId, query, around, before, after, limit } = {}) {
  if (typeof request !== 'function') throw new Error('request required');
  const path = buildDmMessagesPath({ channelId, around, before, after, limit });
  const r = await request(path);
  if (r && isIndexNotReady(r.status, r.body)) {
    return { ok: false, indexNotReady: true, retryAfter: Math.round(retryAfterMs(r.body) / 1000) || 1, messages: [] };
  }
  if (!r || r.status >= 300) {
    return { ok: false, error: (r && r.body && r.body.message) || ('http ' + (r && r.status)), messages: [] };
  }
  let messages = aroundMessages(r.body).map(normalizeMessage).filter(Boolean);
  const q = foldAccents(String(query || '').trim()).toLowerCase();
  if (q) {
    const matched = messages.filter((m) => foldAccents(m.content || '').toLowerCase().includes(q));
    if (matched.length) messages = matched;
  }
  return { ok: true, messages, total: messages.length };
}

function when(ts) {
  if (!ts) return '';
  try { return new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'; }
  catch { return String(ts); }
}

function authorLabel(m) {
  const a = (m && m.author) || {};
  const name = a.username || a.id || '?';
  return a.bot ? name + ' (bot)' : name;
}

function formatHits(hits) {
  const rows = hits || [];
  if (!rows.length) return 'no matches';
  const lines = ['discord search · ' + rows.length + ' hit' + (rows.length === 1 ? '' : 's')];
  let n = 0;
  for (const hit of rows) {
    n += 1;
    const m = hit.message || {};
    const ch = m.channel_id || '';
    const gid = hit.guildId || m.guild_id || '';
    lines.push('');
    lines.push('#' + n + (gid ? '  guild ' + gid : '') + (ch ? '  channel ' + ch : '') + '  ' + m.id);
    lines.push('  ' + authorLabel(m) + (m.timestamp ? '  ' + when(m.timestamp) : ''));
    const ctx = (hit.context && hit.context.length) ? hit.context : [m];
    for (const c of ctx) {
      const mark = String(c.id) === String(m.id) ? '>>' : '  ';
      lines.push('  ' + mark + ' ' + authorLabel(c) + ': ' + String(c.content || '').replace(/\s+/g, ' ').slice(0, 400));
    }
  }
  return lines.join('\n');
}

const DISCORD_API = 'https://discord.com/api/v10';

function botRequest(token, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const auth = String(token || '').trim();
  if (!auth) throw new Error('bot token required');
  return async (path) => {
    const url = path.startsWith('http') ? path : DISCORD_API + path;
    const r = await doFetch(url, {
      headers: {
        Authorization: 'Bot ' + auth,
        'User-Agent': 'asmltr (https://github.com/gtwy/asmltr, 0.16.1)',
      },
    });
    const body = await r.json().catch(() => ({}));
    return { status: r.status, body };
  };
}

async function runSearch(opts) {
  const o = opts || {};
  if (o.dm) {
    return searchDm({
      request: o.request,
      channelId: o.channelId,
      query: o.query,
      around: o.around,
      before: o.before,
      after: o.after,
      limit: o.aroundLimit || o.limit,
    });
  }
  return searchGuilds({
    request: o.request,
    guildIds: o.guildIds,
    query: o.query,
    channelIds: o.channelIds,
    aroundLimit: o.aroundLimit,
    sleep: o.sleep,
  });
}

function formatDm(result) {
  const messages = (result && result.messages) || [];
  if (!messages.length) return 'no matches in this DM window';
  const lines = ['discord DM · ' + messages.length + ' message' + (messages.length === 1 ? '' : 's') + ' (capped window, not a dump)'];
  for (const m of messages) {
    lines.push('  ' + authorLabel(m) + (m.timestamp ? '  ' + when(m.timestamp) : '') + ': ' + String(m.content || '').replace(/\s+/g, ' ').slice(0, 400));
  }
  return lines.join('\n');
}

module.exports = {
  AROUND_LIMIT_MAX,
  SEARCH_LIMIT_MAX,
  DEFAULT_AROUND_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  QUERY_VARIANT_MAX,
  INDEX_NOT_READY_CODE,
  INDEX_RETRY_FALLBACK_MS,
  MAX_INDEX_RETRIES,
  capAroundLimit,
  capSearchLimit,
  buildGuildSearchPath,
  buildAroundPath,
  buildDmMessagesPath,
  isIndexNotReady,
  retryAfterMs,
  flattenHits,
  normalizeMessage,
  foldAccents,
  expandQueryVariants,
  mergeHitsByMessageId,
  searchGuilds,
  searchDm,
  runSearch,
  botRequest,
  formatHits,
  formatDm,
};
