'use strict';

/**
 * Guild ACP hard-stop (typing + @mention stop): starter of that turn, or owner.
 * Gentle sleep (awake/idle + stop) is anyone — handled before this runs.
 * Voice / unspecified mode stays open (humans always win) for non-ACP paths.
 */
function canAbortTurn(opts) {
  const o = opts || {};
  if (o.mode === 'gentle') return true;
  if (o.mode === 'hard' || o.mode === 'acp-hard') {
    if (o.isOwner) return true;
    const author = o.authorId != null ? String(o.authorId) : '';
    const starter = o.starterId != null ? String(o.starterId) : '';
    return !!(author && starter && author === starter);
  }
  return true;
}

function starterIdFromSlot(slot) {
  if (!slot || slot === true) return null;
  return slot.starterId == null ? null : String(slot.starterId);
}

module.exports = { canAbortTurn, starterIdFromSlot };
