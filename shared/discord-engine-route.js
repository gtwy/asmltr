'use strict';
/**
 * Discord text ingress → ACP (Grok). STANDARD (Claude SDK) stays for email,
 * GitHub, schedules, voice, and other non-Discord channels.
 *
 * Voice turns (`discord-voice:` / channel_context.voice) are not ACP text.
 */
const { isDiscordVoice } = require('./media-allow');

const ACP_ENGINE = 'grok';

function acpEngineId() {
  const raw = String(process.env.ASMLTR_DISCORD_ACP_ENGINE || '').trim().toLowerCase();
  if (raw && raw !== 'claude') return raw;
  return ACP_ENGINE;
}

function isDiscordTextIngress(envelope) {
  if (!envelope || typeof envelope !== 'object') return false;
  if (isDiscordVoice(envelope)) return false;
  const ch = String(envelope.channel || '').trim().toLowerCase();
  if (ch === 'discord') return true;
  const key = String(envelope.conversation_key || envelope.conversationKey || '');
  return key.startsWith('discord:') && !key.startsWith('discord-voice:');
}

/**
 * Engine id for this envelope, or undefined so the caller uses the configured default.
 * Discord text always returns the ACP engine — even if opts.engine is claude.
 */
function engineForEnvelope(envelope, opts) {
  if (isDiscordTextIngress(envelope)) return acpEngineId();
  if (opts && opts.engine) return opts.engine;
  return undefined;
}

module.exports = { engineForEnvelope, isDiscordTextIngress, acpEngineId };
