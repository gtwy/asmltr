'use strict';
/**
 * Optional one-hook: when moderation denies a speaker in an awake guild ACP
 * channel, notify the operator (same admin-alert path as high-risk blocks).
 */
function shouldNotifyModBlock(envelope, mod) {
  if (!mod || mod.allowed) return false;
  if (Number(mod.riskLevel) >= 7) return true;
  const cc = envelope && envelope.channel_context;
  if (
    envelope
    && String(envelope.channel || '').toLowerCase() === 'discord'
    && envelope.public
    && cc && cc.acpAwake
  ) {
    return true;
  }
  return false;
}

module.exports = { shouldNotifyModBlock };
