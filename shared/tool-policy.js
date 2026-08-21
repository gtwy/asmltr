'use strict';
/**
 * V31: per-turn tool policy. Restricted Discord cannot shell/streams/send.
 * Silo only if the guild/channel is in the host allowlist (never git).
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
    return {
      guilds: (silo.guilds || []).map(String),
      channels: (silo.channels || []).map(String),
    };
  } catch {
    return { guilds: [], channels: [] };
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

function policyFor(envelope, resolved, allow) {
  const deny = { shell: false, streams: false, send: false, silo: false };
  if (!isRestricted(envelope, resolved)) return { deny, restricted: false };
  deny.shell = true;
  deny.streams = true;
  deny.send = true;
  deny.silo = !siloAllowlisted(envelope, allow);
  return { deny, restricted: true };
}

function denyToolsEnv(deny) {
  return ['shell', 'streams', 'send', 'silo'].filter((k) => deny && deny[k]).join(',');
}

function parseDenyEnv(raw) {
  const set = new Set(String(raw || '').split(',').map((x) => x.trim()).filter(Boolean));
  return {
    shell: set.has('shell'),
    streams: set.has('streams'),
    send: set.has('send'),
    silo: set.has('silo'),
  };
}

function exitIfDenied(kind) {
  const d = parseDenyEnv(process.env.ASMLTR_DENY_TOOLS);
  if (d[kind]) {
    console.error('denied: ' + kind);
    process.exit(2);
  }
}

module.exports = {
  policyFile, loadAllowlist, policyFor, isRestricted, siloAllowlisted,
  denyToolsEnv, parseDenyEnv, exitIfDenied, guildIdFrom, channelIdFrom,
};
