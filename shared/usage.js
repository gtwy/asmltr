'use strict';
/**
 * Aux usage — build a priced `token-usage` event for the paid side-surfaces that a turn triggers but
 * that aren't the reasoning engine itself: TTS synthesis (chars), STT transcription (seconds), and the
 * moderation / labeler model calls (tokens). These almost always run on a metered API key, so they're
 * where the Usage view's **Billed $** actually comes from.
 *
 * This module is pure: it returns an event *partial* (the shared/events.js shape) with cost_usd /
 * billed_cost_usd computed from shared/pricing. The caller emits it through whichever sink it already
 * has — core's `record()` or a connector's `ctx.emit()` — so we never duplicate collector-URL/token
 * plumbing. The `feature`/`provider`/`units`/`count` land in the payload so the collector can roll them
 * up per-feature/provider for the breakdown panel.
 *
 * Usage:
 *   record(auxUsage({ surface: e.channel, identity, session_id, feature: 'tts',
 *                     provider: 'elevenlabs', model, chars }))
 *   ctx.emit(auxUsage({ surface: 'discord', identity, feature: 'stt', provider: 'openai', model, seconds }))
 */
const pricing = require('./pricing');

/**
 * @param {object} o
 * @param {string}  o.feature   'tts' | 'stt' | 'moderation' | 'label' (free-form; used for the breakdown)
 * @param {string} [o.provider] 'openai' | 'elevenlabs' | 'anthropic' | ...
 * @param {string} [o.model]    model id used (priced via shared/pricing longest-prefix match)
 * @param {string}  o.surface   the triggering channel (discord|telegram|assistant-web|assistant-native|...)
 * @param {string} [o.identity] resolved user/channel key (attributes the cost to a person)
 * @param {string} [o.session_id]
 * @param {number} [o.chars]    TTS: characters synthesized  → priced per 1k chars
 * @param {number} [o.seconds]  STT: seconds of audio        → priced per minute
 * @param {number} [o.tokens_in]  token features: prompt tokens
 * @param {number} [o.tokens_out] token features: completion tokens
 * @param {boolean}[o.billed]   defaults true (metered key). Pass false for a subscription-backed aux call.
 * @returns {object} an event partial ready for record()/ctx.emit()
 */
function auxUsage(o = {}) {
  const feature = o.feature || 'aux';
  let cost = 0; let units = 'calls'; let count = 1;
  let tokens_in = 0; let tokens_out = 0;

  if (o.chars != null) {
    count = Math.max(0, Math.round(o.chars)); units = 'chars';
    cost = pricing.ttsCostUsd(o.model, count);
  } else if (o.seconds != null) {
    count = Math.max(0, Math.round(o.seconds)); units = 'seconds';
    cost = pricing.sttCostUsd(o.model, o.seconds);
  } else if (o.tokens_in != null || o.tokens_out != null) {
    tokens_in = Math.max(0, Math.round(o.tokens_in || 0));
    tokens_out = Math.max(0, Math.round(o.tokens_out || 0));
    count = tokens_in + tokens_out; units = 'tokens';
    cost = pricing.tokenCostUsd(o.model, tokens_in, tokens_out);
  }

  const billed = o.billed !== false; // aux surfaces are metered unless told otherwise
  return {
    surface: o.surface,
    session_id: o.session_id != null ? o.session_id : null,
    identity: o.identity != null ? o.identity : null,
    event_type: 'token-usage',
    // Token features contribute to the token totals; char/second features do not (they're not tokens).
    tokens_in, tokens_out,
    cost_usd: cost,
    billed_cost_usd: billed ? cost : 0,
    source: 'aux',
    payload: {
      feature,
      provider: o.provider || undefined,
      model: o.model || undefined,
      units, count,
      billed,
      aux: true,
    },
  };
}

/**
 * Best-effort audio duration in seconds for STT cost accounting, when the model didn't return a real
 * `duration`. Estimates from encoded byte length using a nominal bitrate per container (browser/opus
 * clips are ~24-32 kbps; wav is uncompressed PCM). Rough by design — STT is cheap ($/min) so a ballpark
 * keeps the Billed total honest without decoding the media. Callers should mark the event estimated.
 * @param {number} bytes encoded clip size
 * @param {string} [mime]
 * @returns {number} seconds (>= 0)
 */
function estimateAudioSeconds(bytes, mime = '') {
  const b = Number(bytes) || 0;
  const m = String(mime).toLowerCase();
  // bytes per second at the nominal bitrate: bitrate_bps / 8.
  let bps;
  if (/wav|pcm|l16/.test(m)) bps = 16000 * 2; // 16kHz * 16-bit mono PCM
  else if (/mp3|mpeg/.test(m)) bps = 32000 / 8; // ~32 kbps
  else bps = 32000 / 8; // webm/opus/ogg/m4a default ~32 kbps
  return b > 0 ? b / bps : 0;
}

module.exports = { auxUsage, estimateAudioSeconds };
