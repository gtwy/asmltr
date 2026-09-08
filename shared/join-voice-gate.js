'use strict';
/**
 * join-voice is fully off until rebuilt — not owner-only, off for everyone.
 */
const JOIN_VOICE_OFF_MSG = '🎙️ Voice join is off until it is rebuilt.';

function joinVoiceAllowed() {
  const v = String(process.env.ASMLTR_DISCORD_JOIN_VOICE || '').trim().toLowerCase();
  return v === '1' || v === 'on' || v === 'true' || v === 'yes';
}

module.exports = { joinVoiceAllowed, JOIN_VOICE_OFF_MSG };
