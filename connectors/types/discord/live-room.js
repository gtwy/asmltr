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
 * Session instruction suffix. Group and 1:1: she is on the call to talk.
 */
function roomInstructions(humans) {
  const n = Number(humans);
  const count = Number.isFinite(n) ? n : 0;
  if (count <= 1) {
    return 'This is a 1:1 voice call. Every utterance is for you. Always answer. No name is required. Err on talking. If they say stop or hold on, skip that bit, stay on the line, and answer the next turn.';
  }
  return 'You are on this group voice call to talk. Every human speaking-stop is a turn for you. Do not wait for your name. Do not default to silence. Err on talking too much. If they say that was not for you, hold on, or stop, skip that bit, stay on the line, and answer the next turn.';
}

/** Spoken skip: that last turn was not for her. Session memory, not mute. */
function wasNotForHer(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  return /\b(that )?(wasn'?t|isn'?t|not) (for you|for ivy|meant for you)\b/.test(t)
    || /\b(didn'?t|did not) (ask|mean) you\b/.test(t)
    || /\bnobody asked you\b/.test(t)
    || /\bnot you,? ivy\b/.test(t)
    || /\bhold (on|up)\b/.test(t)
    || /\b(stop|that'?s enough)\b/.test(t);
}

function roomSkipNote() {
  return 'Someone said to skip that bit (not for you, hold on, or stop). Stay on the call. Answer the next turn. Do not go silent.';
}

/** Discord speaking-stop of a non-bot human must produce a spoken reply. Group same as 1:1. Not while her mouth is playing. */
function shouldForceTurn({ herMouth } = {}) {
  return !herMouth;
}

module.exports = { countHumans, roomInstructions, shouldForceTurn, wasNotForHer, roomSkipNote };
