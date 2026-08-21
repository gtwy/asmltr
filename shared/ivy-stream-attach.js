'use strict';
/**
 * V32: the `ivy` stream is owner local memory + host silo-allowlisted Discord
 * (kektech). Work/email/GitHub/schedule stay off it. privacy.md still gates
 * what may be *said* in a mixed room.
 */
const { siloAllowlisted } = require('./tool-policy');

function shouldAttachIvyStream(envelope, resolved, allow) {
  const ch = String((envelope && envelope.channel) || '');
  if (ch === 'email' || ch === 'github' || ch === 'schedule') return false;
  if (ch === 'discord' && siloAllowlisted(envelope, allow)) return true;
  if (!(resolved && resolved.bypass_moderation)) return false;
  if (ch === 'discord' && envelope && envelope.public) return false;
  return true;
}

module.exports = { shouldAttachIvyStream };
