'use strict';

/** Cancel a spoken reply only after audio is actually playing, grace has elapsed, and (if set) the user has talked through minSpeechMs. */
function shouldBargeIn({ busy, speaking, replyStartedAt, now, graceMs, userSpeechMs, minSpeechMs = 0 }) {
  if (!busy) return false;
  if (!speaking) return false;
  if (replyStartedAt == null) return false;
  if ((now - replyStartedAt) < graceMs) return false;
  const min = Number(minSpeechMs);
  const need = Number.isFinite(min) && min > 0 ? min : 0;
  if (need > 0) {
    const speech = Number(userSpeechMs);
    if (!Number.isFinite(speech) || speech < need) return false;
  }
  return true;
}

module.exports = { shouldBargeIn };
