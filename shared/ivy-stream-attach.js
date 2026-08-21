'use strict';
/**
 * V32: the `ivy` stream is owner local memory. Do not attach work/email or
 * public Discord keys so kektech recall cannot pull those threads.
 */

function shouldAttachIvyStream(envelope, resolved) {
  if (!(resolved && resolved.bypass_moderation)) return false;
  const ch = String((envelope && envelope.channel) || '');
  if (ch === 'email' || ch === 'github' || ch === 'schedule') return false;
  if (ch === 'discord' && envelope && envelope.public) return false;
  return true;
}

module.exports = { shouldAttachIvyStream };
