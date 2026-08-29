'use strict';
/**
 * Ivy Live function tools + speaker identity/silo for converse-grok.
 *
 * session.tools are asmltr function tools from mcp/toolbelt-server.js (same names),
 * converted to realtime `{type:'function', name, description, parameters}`.
 * Native xAI web_search / x_search / mcp are never advertised — those skip asmltr TRUST.
 *
 * Execution uses the existing toolbelt invoke path (CLI / voice HTTP) gated by
 * tool-policy for a Discord TEXT principal (NOT the handleStream voice deny-all).
 */
const { policyFor, grantTokens } = require('../tool-policy');
const converseGrok = require('./converse-grok');

function toolbelt() {
  return require('../../mcp/toolbelt-server');
}

function textEnvelope({ instanceId, guildId, channelId, userId, username } = {}) {
  const iid = instanceId || 'ivy';
  const gid = guildId != null ? String(guildId) : '';
  const cid = channelId != null ? String(channelId) : '';
  return {
    channel: 'discord',
    conversation_key: cid
      ? `discord:${iid}:channel:${cid}`
      : (gid ? `discord:${iid}:guild:${gid}` : `discord:${iid}`),
    sender: { raw_id: userId != null ? String(userId) : '', raw_username: username || '' },
    context: { scope_id: gid ? `guild:${gid}` : '' },
    channel_context: { channelId: cid, guildId: gid },
  };
}

function isUntrusted(resolved) {
  if (!resolved || resolved.is_default || resolved.revoked) return true;
  if (resolved.bypass_moderation || resolved.user_key === 'owner') return false;
  return grantTokens(resolved).length === 0;
}

function toolsForSpeaker(resolved, envelope) {
  if (isUntrusted(resolved)) return [];
  const pol = policyFor(envelope, resolved);
  const listed = toolbelt().listTools(pol && pol.deny);
  let tools = converseGrok.asRealtimeFunctions(listed);
  if (!(resolved.bypass_moderation || resolved.user_key === 'owner')) {
    tools = tools.filter((t) => t.name !== 'voice_join');
  }
  return tools;
}

function speakerIdentityLine({ channel, speakerId, speakerName } = {}) {
  const spkName = speakerName || 'an unidentified user';
  const spkId = speakerId != null && speakerId !== '' ? String(speakerId) : 'unknown';
  const ch = channel || 'discord';
  return 'CURRENT SPEAKER — READ FIRST, TRUST THIS OVER EVERYTHING ELSE:\n'
    + `The message you are answering on THIS turn is from ${spkName} (${ch}:${spkId}). `
    + `Treat and address them as ${spkName}. Do NOT assume they are anyone else — not the owner of this machine, `
    + 'not a person from earlier in this conversation, not whoever your base instructions (CLAUDE.md) call "your user". '
    + 'This channel can carry multiple people and the speaker can change between turns; this line always reflects who is '
    + 'speaking NOW. If asked "who am I" / "who are you talking to", answer with exactly this identity.';
}

function siloRecallBlock(recalled) {
  const body = String(recalled || '').trim();
  if (!body) return '';
  return 'PRIOR CONVERSATION (from Self silo; this is a FRESH engine session after idle or first turn). Use this as your memory of earlier chat. Do NOT grep events-*.jsonl for prior conversation.\n\n' + body;
}

function buildLiveInstructions({ voiceGuidance, identity, speakerLine, siloRecall } = {}) {
  return [voiceGuidance, identity, speakerLine, siloRecall].filter(Boolean).join('\n\n');
}

async function executeFunctionCall({ name, args, resolved, envelope, turn, invoke } = {}) {
  const denied = JSON.stringify({ ok: false, error: 'denied' });
  if (!name || converseGrok.isNativeTool({ name, type: 'function' })) return denied;
  if (isUntrusted(resolved)) return denied;
  const pol = policyFor(envelope, resolved);
  const belt = toolbelt();
  const t = belt.BY_NAME[name];
  if (!t) return JSON.stringify({ ok: false, error: 'unknown tool' });
  if (pol.deny && (pol.deny.all || (t.deny && pol.deny[t.deny]))) return denied;
  if (name === 'voice_join' && !(resolved.bypass_moderation || resolved.user_key === 'owner')) return denied;
  const inv = invoke || belt.invokeTool;
  const r = await inv(name, args || {}, { deny: pol.deny, turn });
  if (r && r.isError && String(r.error || r.text || '').startsWith('denied')) return denied;
  return typeof r === 'string' ? r : JSON.stringify(r == null ? { ok: true } : r);
}

module.exports = {
  textEnvelope, isUntrusted, toolsForSpeaker, speakerIdentityLine,
  siloRecallBlock, buildLiveInstructions, executeFunctionCall,
};
