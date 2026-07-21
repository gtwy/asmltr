'use strict';
/**
 * Liveness-heartbeat health, kept as pure functions so the staleness decision is testable without a
 * running supervisor, a child process, or a clock.
 *
 * Why this exists: the supervisor sets rec.status from process lifecycle alone — 'running' means the
 * child pid is alive, nothing more. A connector can hold that pid while its I/O loop is dead. On
 * 2026-07-16 the telegram poller logged `polling_error: EFATAL`, the getUpdates loop stopped, and the
 * process stayed up for 3+ days while GET /instances still reported `running`. A heartbeat that a
 * connector emits from its ACTIVE I/O path (a successful poll cycle, a gateway that's still Ready)
 * closes that gap: no heartbeat inside the threshold means the loop is deaf even though the pid lives.
 */

// Line written to a child's stdout by ctx.heartbeat(); the supervisor scrapes stdout already, so this
// reuses the one child->manager channel that exists (children are spawn()ed, not fork()ed, so there
// is no process.send IPC). Kept token-distinct so it never collides with a real log line.
const HEARTBEAT_TOKEN = '@@ASMLTR_HEARTBEAT@@';

// How often a connector emits a heartbeat from its I/O path. Comfortably below the default stale
// threshold so a healthy-but-quiet connector clears it with room to spare (30s vs 120s = 4 chances).
const HEARTBEAT_INTERVAL_MS = 30000;

const DEFAULT_STALE_MS = 120000;

function staleThresholdMs(env = process.env) {
  const v = Number(env.ASMLTR_HEARTBEAT_STALE_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_STALE_MS;
}

// A connector that has never emitted a heartbeat is 'unknown', not stale: a just-spawned instance
// has not run its I/O path yet, so flagging it would fire on every restart. Only an instance that
// proved it was alive once, then went silent past the threshold, is stale.
function isStale(lastHeartbeat, now, thresholdMs) {
  if (!lastHeartbeat) return false;
  return now - lastHeartbeat > thresholdMs;
}

// Full health block merged into an instance's runtime status by the supervisor.
// heartbeat: 'unknown' (never seen) | 'alive' (within threshold) | 'stale' (past threshold).
// healthy: null when unknown, else the boolean; lastHeartbeatAgeMs: null when unknown, else the age.
function heartbeatHealth(lastHeartbeat, now, thresholdMs) {
  if (!lastHeartbeat) return { heartbeat: 'unknown', healthy: null, lastHeartbeatAgeMs: null };
  const age = now - lastHeartbeat;
  const stale = age > thresholdMs;
  return { heartbeat: stale ? 'stale' : 'alive', healthy: !stale, lastHeartbeatAgeMs: age };
}

module.exports = { HEARTBEAT_TOKEN, HEARTBEAT_INTERVAL_MS, DEFAULT_STALE_MS, staleThresholdMs, isStale, heartbeatHealth };
