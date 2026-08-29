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
 * Session instruction suffix. Speak when targeted, not on every pause.
 */
function roomInstructions(humans) {
  const n = Number(humans);
  const count = Number.isFinite(n) ? n : 0;
  if (count <= 1) {
    return 'This is a 1:1 voice call. Every utterance is for you. Always answer. No name is required. If they say stop or hold on, skip that bit, stay on the line, and answer the next turn.';
  }
  return 'This is a group voice call. Speak when you are the target of the comment: named, clearly spoken to, or the same person you just answered continuing. Do not jump in whenever there is a pause. Do not wait to be named every time. Two other people talking to each other: stay out. If they say that was not for you, hold on, or stop, skip that bit, stay on the line, and answer the next turn that is for you.';
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
  return 'Someone said to skip that bit (not for you, hold on, or stop). Stay on the call. Answer the next turn that is for you. Do not go silent.';
}

/** 1:1: Discord speaking-stop → response.create. Not while her mouth is playing. */
function shouldForceTurn({ humans, herMouth } = {}) {
  const n = Number(humans);
  const count = Number.isFinite(n) ? n : 0;
  return count <= 1 && !herMouth;
}

/** Group: respond only if named, latched last-answered speaker, or 1:1. */
function isGroupAddressee({ named, speakerId, lastAnsweredId, humans } = {}) {
  const n = Number(humans);
  const count = Number.isFinite(n) ? n : 0;
  if (count <= 1) return true;
  if (named) return true;
  const a = speakerId != null && speakerId !== '' ? String(speakerId) : '';
  const b = lastAnsweredId != null && lastAnsweredId !== '' ? String(lastAnsweredId) : '';
  if (a && b && a === b) return true;
  return false;
}

module.exports = { countHumans, roomInstructions, shouldForceTurn, wasNotForHer, roomSkipNote, isGroupAddressee };
