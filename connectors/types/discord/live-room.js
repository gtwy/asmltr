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
  return 'You were brought into this voice call to talk. Default is to engage when input is welcome: a question in the air, a pause for you, or being included. Lean in. Do not default to silence. Do not wait for your name.';
}

/** Spoken skip: that last turn was not for her. Session memory, not mute. */
function wasNotForHer(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  return /\b(that )?(wasn'?t|isn'?t|not) (for you|for ivy|meant for you)\b/.test(t)
    || /\b(didn'?t|did not) (ask|mean) you\b/.test(t)
    || /\bnobody asked you\b/.test(t)
    || /\bnot you,? ivy\b/.test(t);
}

function roomSkipNote() {
  return 'Someone said a recent turn was not for you. Do not keep talking over that side conversation. Stay on the call. Speak again when a question is in the air, they pause for you, or they include you.';
}

/** 1:1: Discord speaking-stop must produce a spoken reply. Not while her mouth is playing. */
function shouldForceTurn({ humans, herMouth } = {}) {
  const n = Number(humans);
  const count = Number.isFinite(n) ? n : 0;
  return count <= 1 && !herMouth;
}

module.exports = { countHumans, roomInstructions, shouldForceTurn, wasNotForHer, roomSkipNote };

