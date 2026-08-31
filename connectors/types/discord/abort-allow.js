'use strict';

/** Public: anyone may abort an in-flight turn (humans always win). Host overlay wraps to starter-or-owner. */
function canAbortTurn(_opts) {
  return true;
}

function starterIdFromSlot(slot) {
  if (!slot || slot === true) return null;
  return slot.starterId == null ? null : String(slot.starterId);
}

module.exports = { canAbortTurn, starterIdFromSlot };

try {
  const ov = require('../../../shared/load-host-overlay').load('stop-starter-or-owner');
  if (ov && typeof ov.wrapAbortAllow === 'function') ov.wrapAbortAllow(module.exports);
} catch (_) {}
