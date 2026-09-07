'use strict';
/**
 * User-turn catch-up glue: self-sent cross-posts + optional guild last-N
 * (fresh public Discord resume only) + observed-but-not-replied lines.
 *
 * Guild scrollback must NOT enter the DM PRIOR / silo recall path.
 */
function composeUserCatchUp({
  selfSent = '',
  observed = '',
  guildScrollback = '',
  isNew = false,
  publicDiscord = false,
} = {}) {
  const extra = (isNew && publicDiscord && guildScrollback) ? String(guildScrollback) : '';
  return String(selfSent || '') + extra + String(observed || '');
}

module.exports = { composeUserCatchUp };
