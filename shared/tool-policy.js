'use strict';
/**
 * V31: per-turn tool policy. Restricted Discord cannot shell/streams/send/cwd-write.
 * Silo read/write is not part of that deny (James 21 Aug 2026). Do not fold
 * silo denies into a V31 PR — privacy.md is the silo safeguard.
 * Video gen (image_to_video / reference_to_video) is owner/bypass unless
 * tool-policy.json videoAllow names a principal or Discord id.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function policyFile() {
  return process.env.ASMLTR_TOOL_POLICY_FILE
    || path.join(os.homedir(), '.asmltr', 'tool-policy.json');
}

function loadAllowlist(file) {
  const p = file || policyFile();
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const silo = (j && j.siloAllow) || {};
    const video = (j && j.videoAllow) || {};
    return {
      guilds: (silo.guilds || []).map(String),
      channels: (silo.channels || []).map(String),
      videoPrincipals: (video.principals || []).map(String),
      videoDiscordIds: (video.discordIds || []).map(String),
    };
  } catch {
    return { guilds: [], channels: [], videoPrincipals: [], videoDiscordIds: [] };
  }
}

function guildIdFrom(envelope) {
  const sid = envelope && envelope.context && envelope.context.scope_id;
  const s = String(sid || '');
  if (s.startsWith('guild:')) return s.slice(6);
  return '';
}

function channelIdFrom(envelope) {
  const cc = envelope && envelope.channel_context;
  if (!cc) return '';
  return String(cc.channelId || cc.channel_id || '');
}

function siloAllowlisted(envelope, allow) {
  const a = allow || loadAllowlist();
  const g = guildIdFrom(envelope);
  const c = channelIdFrom(envelope);
  return !!(g && a.guilds.includes(g)) || !!(c && a.channels.includes(c));
}

function isRestricted(envelope, resolved) {
  const ch = String((envelope && envelope.channel) || '');
  if (ch !== 'discord') return false;
  if (envelope && envelope.public) return true;
  return !(resolved && resolved.bypass_moderation);
}

function senderRawId(envelope) {
  const s = envelope && envelope.sender;
  return String((s && (s.raw_id || s.id)) || '');
}

/** Video gen is owner/bypass unless videoAllow names this principal or Discord id. */
function videoAuthorized(envelope, resolved, allow) {
  if (resolved && (resolved.bypass_moderation || resolved.user_key === 'owner')) return true;
  const a = allow || loadAllowlist();
  const key = String((resolved && resolved.user_key) || '');
  if (key && (a.videoPrincipals || []).includes(key)) return true;
  const did = senderRawId(envelope);
  if (did && (a.videoDiscordIds || []).includes(did)) return true;
  return false;
}

function emptyDeny() {
  return { shell: false, streams: false, send: false, silo: false, write: false, siloWrite: false, video: false };
}

function policyFor(envelope, resolved, allow) {
  const deny = emptyDeny();
  if (!videoAuthorized(envelope, resolved, allow)) deny.video = true;
  if (!isRestricted(envelope, resolved)) return { deny, restricted: false };
  deny.shell = true;
  deny.streams = true;
  deny.send = true;
  deny.write = true;
  return { deny, restricted: true };
}

function denyToolsEnv(deny) {
  return ['shell', 'streams', 'send', 'silo', 'write', 'siloWrite', 'video'].filter((k) => deny && deny[k]).join(',');
}

function parseDenyEnv(raw) {
  const set = new Set(String(raw || '').split(',').map((x) => x.trim()).filter(Boolean));
  return {
    shell: set.has('shell'),
    streams: set.has('streams'),
    send: set.has('send'),
    silo: set.has('silo'),
    write: set.has('write'),
    siloWrite: set.has('siloWrite'),
    video: set.has('video'),
  };
}

function exitIfDenied(kind) {
  const d = parseDenyEnv(process.env.ASMLTR_DENY_TOOLS);
  const mapped = kind === 'announce' ? 'send' : kind;
  if (d[mapped] || d[kind]) {
    console.error('denied: ' + mapped);
    process.exit(2);
  }
}

module.exports = {
  policyFile, loadAllowlist, policyFor, isRestricted, siloAllowlisted,
  videoAuthorized, denyToolsEnv, parseDenyEnv, exitIfDenied, guildIdFrom, channelIdFrom,
};
