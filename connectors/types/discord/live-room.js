'use strict';

/**
 * Humans in a Discord voice channel, not counting Ivy (selfUserId) and not counting bots.
 */
function countHumans(channel, selfUserId) {
  if (!channel || channel.members == null) return 0;
  const self = selfUserId != null && selfUserId !== '' ? String(selfUserId) : '';
  const members = channel.members;
  const iter = typeof members.values === 'function' ? members.values()
    : (Array.isArray(members) ? members : Object.values(members));
  let n = 0;
  for (const m of iter) {
    if (!m) continue;
    const u = m.user || m;
    const id = m.id != null ? String(m.id)
      : (u && u.id != null ? String(u.id) : '');
    if (!id) continue;
    if (self && id === self) continue;
    if (u && u.bot) continue;
    n += 1;
  }
  return n;
}

/**
 * Session instruction suffix. humans <= 1 → every utterance is for her.
 */
function roomInstructions(humans) {
  const n = Number(humans);
  const count = Number.isFinite(n) ? n : 0;
  if (count <= 1) {
    return 'This is a 1:1 voice call. Every utterance is for you. Always answer. No name is required. Do not wait to judge whether it was for you.';
  }
  return 'This is a group voice call. Always listen. Answer when you are addressed by name, by context, or when you are being spoken to. Stay silent when the humans are talking among themselves.';
}

module.exports = { countHumans, roomInstructions };
