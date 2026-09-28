'use strict';
/**
 * Who can read a conversation, for deciding what owner-private context may be injected into it.
 *
 * A MULTI-USER ROOM is a conversation other people read: a public post, a Discord guild channel, a
 * group chat. The owner's cross-channel last-topics index and broadcast (`*`) session announcements
 * carry owner-private work, so neither is injected into a room, even on a turn the owner started (the
 * engine session is shared by everyone who speaks there).
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

module.exports = { isMultiUserRoom, ownerTopicsAllowed, envelopeScope };
