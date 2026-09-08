'use strict';
/**
 * Owner in a public guild: same tools as everyone + bypass_moderation.
 * Restricted asks refuse in-channel and hand off to a private DM session.
 * No customer / private-operator internals in the public reply.
 */
const HANDOFF_SENTINEL = '[[HANDOFF]]';
const HANDOFF_RE = /\[\[HANDOFF\]\]/g;

function stripHandoffSentinel(text) {
  return String(text || '').replace(HANDOFF_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

function wantsHandoff(text) {
  return /\[\[HANDOFF\]\]/.test(String(text || ''));
}

function refuseInChannelText() {
  return "I can't do that in this channel. I'll DM you.";
}

function handoffUserText({ question, contextText, channelName, requesterName } = {}) {
  const q = String(question || '').trim();
  const ctx = String(contextText || '').trim();
  const where = channelName ? ` from #${String(channelName).replace(/^#/, '')}` : '';
  const who = requesterName ? String(requesterName) : 'the operator';
  const parts = [
    `HANDOFF${where} (${who}). Continue in this private DM.`,
  ];
  if (ctx) parts.push('Context:\n' + ctx.slice(0, 2000));
  if (q) parts.push('Question:\n' + q.slice(0, 2000));
  return parts.join('\n\n');
}

function handoffEnvelope({
  instanceId, ownerId, question, contextText, channelName, requesterName, sender,
} = {}) {
  const oid = String(ownerId || '');
  const inst = String(instanceId || 'default');
  return {
    channel: 'discord',
    conversation_key: `discord:${inst}:dm:${oid}`,
    sender: sender || { raw_id: oid, raw_username: requesterName || 'owner' },
    content: { text: handoffUserText({ question, contextText, channelName, requesterName }) },
    delivery: 'async',
    public: false,
    context: { scope_id: `dm:${oid}` },
  };
}

module.exports = {
  HANDOFF_SENTINEL,
  stripHandoffSentinel,
  wantsHandoff,
  refuseInChannelText,
  handoffUserText,
  handoffEnvelope,
};
