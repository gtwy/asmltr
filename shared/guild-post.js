'use strict';
/**
 * Same-guild Discord post. Access cards tier 1–5 or owner. Not asmltr send:
 * no email, no telegram, no other Discord servers, never the same channel
 * they asked from. Remote body has no thought chips. Ask-channel reply is
 * a short "Post complete." — not a copy of the post.
 *
 * Connector always prepends: Posting on behalf of <@speakerId>
 * then two blank lines, then the body. Forum: target the THREAD
 * to comment; targeting the forum channel starts a NEW post.
 */

const { stripThoughtChrome } = require('./step-public');

function prefaceOnBehalf(speakerId, text) {
  const id = String(speakerId || '').replace(/[^\d]/g, '');
  let body = String(text || '').replace(/^\s*posting on behalf of\s+<@\d+>\s*/i, '');
  body = stripThoughtChrome(body).trim();
  if (!id) return { ok: false, error: 'on_behalf_of speaker id required' };
  if (!body) return { ok: false, error: 'text required' };
  return { ok: true, body, text: 'Posting on behalf of <@' + id + '>\n\n\n' + body };
}

function sameChannel(sourceId, destId) {
  const a = String(sourceId || '').trim();
  const b = String(destId || '').trim();
  return !!(a && b && a === b);
}

function sameGuild(sourceGuild, destGuild) {
  const a = String(sourceGuild || '').trim();
  const b = String(destGuild || '').trim();
  if (!a) return { ok: false, error: 'source guild required (this turn must be in a Discord server)' };
  if (!b) return { ok: false, error: 'target is not in a Discord server (no DMs, no off-server)' };
  if (a !== b) return { ok: false, error: 'no sending off server' };
  return { ok: true };
}

function forumTitle(title, body) {
  const raw = String(title || '').trim() || String(body || '').split(/\n/)[0].trim();
  const s = raw.replace(/\s+/g, ' ').slice(0, 100);
  return s || 'post';
}

function isForumChannel(ch) {
  if (!ch) return false;
  if (typeof ch.isThread === 'function' && ch.isThread()) return false;
  const t = ch.type;
  return t === 15 || t === 'GUILD_FORUM' || String(t) === '15';
}

function destGuildId(ch) {
  if (!ch) return '';
  if (ch.guildId) return String(ch.guildId);
  if (ch.guild && ch.guild.id) return String(ch.guild.id);
  return '';
}

module.exports = { prefaceOnBehalf, sameGuild, sameChannel, forumTitle, isForumChannel, destGuildId };
