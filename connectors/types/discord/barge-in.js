'use strict';

/** Cancel a spoken reply only after audio is actually playing and grace has elapsed. */
function shouldBargeIn({ busy, speaking, replyStartedAt, now, graceMs }) {
  if (!busy) return false;
  if (!speaking) return false;
  if (replyStartedAt == null) return false;
  return (now - replyStartedAt) >= graceMs;
}

module.exports = { shouldBargeIn };
