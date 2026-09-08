'use strict';
/**
 * Guild ACP session: SLEEP by default; wake on a real @mention ping only.
 * Mute (channel disabled) is deaf — this module assumes the caller already
 * dropped muted channels. DMs are not this machine.
 */
const SLEEP_AFTER_MS = Number(process.env.ASMLTR_DISCORD_ACP_SLEEP_MS) > 0
  ? Number(process.env.ASMLTR_DISCORD_ACP_SLEEP_MS)
  : 10 * 60 * 1000;
const SLEEP_EMOJI = '😴';
const STATE = { SLEEP: 'sleep', AWAKE: 'awake' };
const STOP_WORDS = new Set(['stop', 'cancel', 'abort', 'halt']);

function stripMentions(text) {
  return String(text || '').replace(/<@[!&]?\d+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function isStopCmd(text) {
  return STOP_WORDS.has(stripMentions(text).toLowerCase());
}

function isBareMention(text) {
  return stripMentions(text) === '';
}

function wantsCaretLookup(text) {
  return String(text || '').includes('^');
}

function hasBotPing(message, botUser) {
  if (!message || !botUser) return false;
  const mentions = message.mentions;
  if (!mentions) return false;
  if (typeof mentions.has === 'function') return !!mentions.has(botUser);
  return false;
}

function createGuildAcpSessions({ now = () => Date.now(), sleepAfterMs = SLEEP_AFTER_MS } = {}) {
  const map = new Map();

  function get(cid) {
    const id = String(cid || '');
    if (!map.has(id)) {
      map.set(id, {
        state: STATE.SLEEP,
        lastWorthReplyAt: 0,
        lastInboundAt: 0,
        turnStarterId: null,
      });
    }
    return map.get(id);
  }

  function isAwake(cid) {
    return get(cid).state === STATE.AWAKE;
  }

  function wake(cid, starterId, t) {
    const s = get(cid);
    const ts = t == null ? now() : t;
    s.state = STATE.AWAKE;
    s.lastWorthReplyAt = ts;
    s.lastInboundAt = ts;
    s.turnStarterId = starterId != null ? String(starterId) : null;
    return s;
  }

  function sleep(cid) {
    const s = get(cid);
    s.state = STATE.SLEEP;
    s.turnStarterId = null;
    return s;
  }

  function noteInbound(cid, t) {
    const s = get(cid);
    s.lastInboundAt = t == null ? now() : t;
    return s;
  }

  function noteReply(cid, t) {
    const s = get(cid);
    const ts = t == null ? now() : t;
    s.lastWorthReplyAt = ts;
    s.lastInboundAt = ts;
    return s;
  }

  function shouldAutoSleep(cid, t) {
    const s = get(cid);
    if (s.state !== STATE.AWAKE) return false;
    const ts = t == null ? now() : t;
    const base = s.lastWorthReplyAt || s.lastInboundAt;
    return base > 0 && (ts - base) >= sleepAfterMs;
  }

  return {
    get, wake, sleep, noteInbound, noteReply, isAwake, shouldAutoSleep, map, STATE,
  };
}

/**
 * Classify a guild ACP inbound. Control-command routing (stop) can use this
 * or handle stop before calling.
 *
 * @returns {{ action: string }}
 */
function classifyGuildInbound({
  isGuild = true,
  muted = false,
  mentionsBot = false,
  text = '',
  processing = false,
  awake = false,
} = {}) {
  if (!isGuild) return { action: 'dm' };
  if (muted) return { action: 'ignore' };
  if (mentionsBot && isStopCmd(text)) {
    if (processing) return { action: 'hard-stop' };
    if (awake) return { action: 'gentle-sleep' };
    return { action: 'ignore' };
  }
  if (!awake) {
    if (mentionsBot) return { action: 'wake' };
    return { action: 'ignore' };
  }
  if (mentionsBot && isBareMention(text)) return { action: 'ignore-reping' };
  if (processing) return { action: 'queue' };
  return { action: 'follow' };
}

module.exports = {
  SLEEP_AFTER_MS,
  SLEEP_EMOJI,
  STATE,
  stripMentions,
  isStopCmd,
  isBareMention,
  wantsCaretLookup,
  hasBotPing,
  createGuildAcpSessions,
  classifyGuildInbound,
};
