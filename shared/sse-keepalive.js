'use strict';
/**
 * SSE keepalive for long silent streaming turns.
 *
 * The connector SDK guards each core request with an idle-socket timeout
 * (ASMLTR_CORE_TIMEOUT_MS, default 15 min) so a dropped core connection cannot
 * strand a channel. A turn that streams nothing for that long (a Discord guild
 * ACP turn is reply-only: no thinking/tool frames) was indistinguishable from
 * a dead core and got destroyed before its reply arrived.
 *
 * A comment frame (": keepalive") resets that socket timer. SSE parsers skip
 * frames with no data: line, so clients see nothing. A dead core stops sending
 * keepalives, so the dropped-connection guard still fires.
 */

const DEFAULT_KEEPALIVE_MS = 60 * 1000;

function keepaliveMs(ms) {
  const raw = ms != null ? ms : process.env.ASMLTR_SSE_KEEPALIVE_MS;
  if (raw == null || raw === '') return DEFAULT_KEEPALIVE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_KEEPALIVE_MS;
}

/** Start writing ": keepalive" frames to an SSE response. Returns stop(). 0 disables. */
function startSseKeepalive(res, ms) {
  const every = keepaliveMs(ms);
  if (!res || typeof res.write !== 'function' || !(every > 0)) return () => {};
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) { clearInterval(timer); return; }
    try { res.write(': keepalive\n\n'); } catch (_) { clearInterval(timer); }
  }, every);
  if (typeof timer.unref === 'function') timer.unref();
  let stopped = false;
  return function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}

module.exports = { startSseKeepalive, keepaliveMs, DEFAULT_KEEPALIVE_MS };
