'use strict';
/**
 * Same-guild Discord post (public rooms included). Not asmltr send:
 * no email, no telegram, no other Discord servers.
 *
 * Connector always prepends: posting on behalf of <@speakerId>
 * then two blank lines, then the body. Forum: target the THREAD
 * to comment; targeting the forum channel starts a NEW post.
 */

function prefaceOnBehalf(speakerId, text) {
  const id = String(speakerId || '').replace(/[^\d]/g, '');
  const body = String(text || '').replace(/^\s*posting on behalf of\s+<@\d+>\s*/i, '').trim();
  if (!id) return { ok: false, error: 'on_behalf_of speaker id required' };
  if (!body) return { ok: false, error: 'text required' };
  return { ok: true, text: 'posting on behalf of <@' + id + '>\n\n\n' + body };
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

module.exports = { prefaceOnBehalf, sameGuild, forumTitle, isForumChannel, destGuildId };
