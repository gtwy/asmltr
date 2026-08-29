'use strict';

/** Default follow-up window after she finishes speaking (same speaker, no wake word). */
const DEFAULT_FOLLOWUP_MS = 25000;

/**
 * Resolve voice_followup_ms.
 * missing / 0 → 25000 so live instances with schema-default 0 start working without a host PATCH.
 * -1 or false → STRICT (name required every turn).
 * any other finite positive → that many ms.
 */
function resolveVoiceFollowupMs(raw) {
  if (raw === false) return 0;
  const n = Number(raw);
  if (raw === -1 || n === -1) return 0;
  if (!Number.isFinite(n) || n === 0) return DEFAULT_FOLLOWUP_MS;
  if (n < 0) return 0;
  return n;
}

/**
 * Accept this utterance without a wake word?
 * addressed → always (name starts / continues a conversation).
 * else: window still open AND same last-speaker / last-addressee userId.
 * Other speakers in the room still need the name.
 */
function shouldAcceptFollowUp({ window, userId, now, addressed } = {}) {
  if (addressed) return true;
  if (!window || window.expires == null) return false;
  if (Number(window.expires) <= Number(now)) return false;
  const a = userId != null && userId !== '' ? String(userId) : '';
  const b = window.userId != null && window.userId !== '' ? String(window.userId) : '';
  if (!a || !b) return false;
  return a === b;
}

/** Build the per-guild window record. Null if strict / no speaker id (name still required). */
function armFollowUp({ now, windowMs, userId } = {}) {
  const ms = Number(windowMs);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const id = userId != null && userId !== '' ? String(userId) : '';
  if (!id) return null;
  return { expires: Number(now) + ms, userId: id };
}

module.exports = { DEFAULT_FOLLOWUP_MS, resolveVoiceFollowupMs, shouldAcceptFollowUp, armFollowUp };
