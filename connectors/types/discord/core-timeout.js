'use strict';
/**
 * How long the Discord connector lets a core request sit silent before it treats the core as dead.
 *
 * The SDK default (ASMLTR_CORE_TIMEOUT_MS, 15 min) destroys a request whose socket has carried no
 * bytes for that long. That guard exists to free the channel lock when the core drops a turn.
 *
 *   - Owner DM (the `dm_allowed_user_id` user in a DM): no idle timeout at all. A silent turn is
 *     left to run. A core that dies is still caught: the SDK rejects when the connection closes
 *     or resets, and the socket has TCP keepalive.
 *   - Guild channel (text or voice): 30 min, `ASMLTR_DISCORD_GUILD_CORE_TIMEOUT_MS` to override
 *     (0 = none). `/v2/stream` sends a keepalive comment every 60 s while a turn runs, so on the
 *     streaming path this only fires when the core has gone 30 min without writing even that.
 *   - Anything else: the SDK default.
 */

const GUILD_CORE_TIMEOUT_MS = 30 * 60 * 1000;

function guildCoreTimeoutMs(env = process.env) {
  const raw = env && env.ASMLTR_DISCORD_GUILD_CORE_TIMEOUT_MS;
  if (raw == null || String(raw).trim() === '') return GUILD_CORE_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : GUILD_CORE_TIMEOUT_MS;
}

/** Is this message the owner's DM? Discord DM channel type is 1 (older builds: 'DM'). */
function isOwnerDm(message, dmUser) {
  if (!message || !message.channel || !dmUser) return false;
  const t = message.channel.type;
  if (t !== 1 && t !== 'DM') return false;
  return !!(message.author && String(message.author.id) === String(dmUser));
}

/** SDK opts for ctx.core.handle / handleStream. `{}` = SDK default. */
function coreRequestOpts({ guild, ownerDm } = {}, env = process.env) {
  if (ownerDm) return { idleTimeoutMs: 0 };
  if (guild) return { idleTimeoutMs: guildCoreTimeoutMs(env) };
  return {};
}

/** Same, straight from a discord.js message. */
function coreOptsForMessage(message, dmUser, env = process.env) {
  return coreRequestOpts({ guild: !!(message && message.guild), ownerDm: isOwnerDm(message, dmUser) }, env);
}

module.exports = { GUILD_CORE_TIMEOUT_MS, guildCoreTimeoutMs, isOwnerDm, coreRequestOpts, coreOptsForMessage };
