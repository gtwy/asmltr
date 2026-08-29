'use strict';

/** Cache key for Live TRUST/instructions: one entry per (guild, member). */
function cacheKey(guildId, userId) {
  return { guildId: String(guildId), userId: String(userId) };
}

/**
 * Nested Map guildId → userId → { instructions, tools }.
 * Prime (resolve+recall) writes; speaker flip only reads.
 */
function createLiveSpeakerCache() {
  const byGuild = new Map();
  return {
    key: cacheKey,
    get(guildId, userId) {
      if (guildId == null || userId == null || userId === '') return undefined;
      const g = byGuild.get(String(guildId));
      if (!g) return undefined;
      return g.get(String(userId));
    },
    set(guildId, userId, value) {
      const gid = String(guildId);
      const uid = String(userId);
      if (!gid || uid === 'undefined' || !uid) return;
      let g = byGuild.get(gid);
      if (!g) { g = new Map(); byGuild.set(gid, g); }
      g.set(uid, value);
    },
    drop(guildId, userId) {
      const g = byGuild.get(String(guildId));
      if (!g) return;
      g.delete(String(userId));
      if (g.size === 0) byGuild.delete(String(guildId));
    },
    dropGuild(guildId) {
      byGuild.delete(String(guildId));
    },
    has(guildId, userId) {
      const g = byGuild.get(String(guildId));
      return !!(g && g.has(String(userId)));
    },
    size() {
      let n = 0;
      for (const g of byGuild.values()) n += g.size;
      return n;
    },
  };
}

/**
 * Voice-channel members to prime. Skip Ivy herself (`selfUserId` = client.user.id).
 */
function membersToPrime(channel, selfUserId) {
  const out = [];
  if (!channel || channel.members == null) return out;
  const self = selfUserId != null && selfUserId !== '' ? String(selfUserId) : '';
  const members = channel.members;
  const iter = typeof members.values === 'function' ? members.values()
    : (Array.isArray(members) ? members : Object.values(members));
  for (const m of iter) {
    if (!m) continue;
    const id = m.id != null ? String(m.id)
      : (m.user && m.user.id != null ? String(m.user.id) : '');
    if (!id) continue;
    if (self && id === self) continue;
    const name = m.displayName
      || (m.user && (m.user.globalName || m.user.username))
      || id;
    out.push({ userId: id, name: String(name) });
  }
  return out;
}

/**
 * voiceStateUpdate → cache action.
 * Ivy join (self, new channel): prime-channel (existing members).
 * Ivy leave: drop-guild.
 * Other join into her channel: prime that user.
 * Other leave her channel: drop that user.
 */
function voiceMemberDelta({ oldChannelId, newChannelId, ivyChannelId, userId, selfUserId } = {}) {
  const oldCid = oldChannelId != null && oldChannelId !== '' ? String(oldChannelId) : '';
  const newCid = newChannelId != null && newChannelId !== '' ? String(newChannelId) : '';
  const ivy = ivyChannelId != null && ivyChannelId !== '' ? String(ivyChannelId) : '';
  const uid = userId != null && userId !== '' ? String(userId) : '';
  const self = selfUserId != null && selfUserId !== '' ? String(selfUserId) : '';
  const isSelf = !!(self && uid && uid === self);

  if (isSelf) {
    if (!newCid && oldCid) return { action: 'drop-guild' };
    if (newCid && newCid !== oldCid) {
      return { action: 'prime-channel', channelId: newCid, dropGuildFirst: !!oldCid };
    }
    return { action: null };
  }
  if (!ivy || !uid) return { action: null };
  if (newCid === ivy && oldCid !== ivy) return { action: 'prime', userId: uid };
  if (oldCid === ivy && newCid !== ivy) return { action: 'drop', userId: uid };
  return { action: null };
}

/**
 * Sync apply from cache onto a converse session.
 * Missing / empty userId → tools [] (do not block the mouth).
 */
function applyFromCache({ cache, guildId, userId, conv, fallbackInstructions } = {}) {
  if (!conv || typeof conv.update !== 'function') return { ok: false, missing: true, tools: [] };
  const uid = userId != null && userId !== '' ? String(userId) : '';
  const hit = uid && cache ? cache.get(guildId, uid) : null;
  if (!hit) {
    conv.update({ instructions: fallbackInstructions || '', tools: [] });
    return { ok: true, missing: true, tools: [] };
  }
  const tools = Array.isArray(hit.tools) ? hit.tools : [];
  conv.update({ instructions: hit.instructions || '', tools });
  return { ok: true, missing: false, tools };
}

module.exports = {
  cacheKey, createLiveSpeakerCache, membersToPrime, voiceMemberDelta, applyFromCache,
};
