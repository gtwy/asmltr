'use strict';
/**
 * Who can read a conversation, for deciding what owner-private context may be injected into it.
 *
 * A MULTI-USER ROOM is a conversation other people read: a public post, a Discord guild channel, a
 * group chat. The owner's cross-channel last-topics index and work announcements carry owner-private
 * work, so neither is injected into a room, even on a turn the owner started (the engine session is
 * shared by everyone who speaks there). Rooms have their own guild announcement scope (see below).
 *
 * The owner's last-topics index is narrower still: it is only injected into the owner's private 1:1
 * conversations. Email threads, GitHub issues and MCP callers can carry other parties or other agents,
 * so they get this conversation's own transcript only.
 */

// conversation_key = <channel>:<instanceId>:<kind>:<id>…  (e.g. discord:<inst>:channel:<id>, :dm:<id>)
const ROOM_KINDS = new Set(['channel', 'group', 'room', 'guild']);
const NO_OWNER_TOPICS_CHANNELS = new Set(['email', 'github', 'mcp']);

function isMultiUserRoom({ conversationKey, public: isPublic, scopeId } = {}) {
  if (isPublic) return true;
  if (/^(guild|group|room):/i.test(String(scopeId || ''))) return true;
  const kinds = String(conversationKey || '').split(':').slice(2);
  return kinds.some((k) => ROOM_KINDS.has(k.toLowerCase()));
}

function ownerTopicsAllowed({ ownerTrust, channel, conversationKey, public: isPublic, scopeId } = {}) {
  if (!ownerTrust) return false;
  if (NO_OWNER_TOPICS_CHANNELS.has(String(channel || '').toLowerCase())) return false;
  return !isMultiUserRoom({ conversationKey, public: isPublic, scopeId });
}

/** The scope fields of a normalized inbound envelope. */
function envelopeScope(e) {
  const env = e || {};
  return {
    conversationKey: env.conversation_key,
    channel: env.channel,
    public: !!env.public,
    scopeId: env.context && env.context.scope_id,
  };
}

/*
 * Two separate announcement (broadcast) systems. Each announcement carries a `scope`; a session
 * only ever drains announcements of its own audience, so nothing crosses between them.
 *
 *   work  — the owner's private work surfaces: the owner's 1:1 chats, email threads, and MCP callers
 *           that are the owner or a listed work principal (ASMLTR_WORK_BROADCAST_PRINCIPALS, comma list
 *           of trust principal ids; default "owner"). Never a room, never someone else's DM, never
 *           other MCP users. GitHub and schedule turns are not in the work audience.
 *   guild — multi-user rooms only (guild channels, group chats, public posts). Something said in one
 *           room can be picked up in another room. Guild announcements never reach work surfaces, and
 *           work announcements never reach rooms.
 */
const BROADCAST_SCOPES = ['work', 'guild'];
const NO_WORK_BROADCAST_CHANNELS = new Set(['github', 'schedule']);

function workBroadcastPrincipals(env = process.env) {
  const raw = String((env && env.ASMLTR_WORK_BROADCAST_PRINCIPALS) || 'owner');
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

/** 'work' | 'guild' | null (null = this conversation drains no announcements). */
function broadcastAudience({ ownerTrust, userKey, channel, conversationKey, public: isPublic, scopeId, env } = {}) {
  if (isMultiUserRoom({ conversationKey, public: isPublic, scopeId })) return 'guild';
  const ch = String(channel || '').toLowerCase();
  if (NO_WORK_BROADCAST_CHANNELS.has(ch)) return null;
  if (ch === 'email') return 'work';
  const listed = !!userKey && workBroadcastPrincipals(env).has(String(userKey));
  if (ch === 'mcp') return (ownerTrust || listed) ? 'work' : null;
  return ownerTrust ? 'work' : null;
}

/**
 * Which scope a new announcement lands in. A room origin always posts to guild (and may not post to
 * work); a known non-room origin always posts to work (and may not post to guild). With no origin key
 * (an operator at a terminal) the explicit request wins, default work.
 * Returns { scope } or { error }.
 */
function resolveAnnounceScope({ requested, originKey } = {}) {
  const req = requested == null || requested === '' ? '' : String(requested).toLowerCase();
  if (req && !BROADCAST_SCOPES.includes(req)) return { error: `scope must be one of ${BROADCAST_SCOPES.join(', ')}` };
  if (originKey) {
    const room = isMultiUserRoom({ conversationKey: originKey });
    if (room) return req && req !== 'guild' ? { error: 'a room may only announce to the guild scope' } : { scope: 'guild' };
    return req && req !== 'work' ? { error: 'only a room may announce to the guild scope' } : { scope: 'work' };
  }
  return { scope: req || 'work' };
}

module.exports = {
  isMultiUserRoom, ownerTopicsAllowed, envelopeScope,
  BROADCAST_SCOPES, broadcastAudience, resolveAnnounceScope, workBroadcastPrincipals,
};
