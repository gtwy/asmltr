'use strict';

/** Join-once chime only. Already in the VC / listening → no chime, no 600ms wait. */
function shouldPlayWakeChime({ listening, connected } = {}) {
  return !listening && !connected;
}

module.exports = { shouldPlayWakeChime };
