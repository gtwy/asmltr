'use strict';
/**
 * James closed the thread. Prompt-only [[NO_REPLY]] and collector kill
 * still mailed (Markay Outlook, 11–12 Sep 2026). This file is re-read on
 * every inbound and every outbound prepare — no bounce to pick up a new row
 * once this module is loaded.
 *
 * Default path: ~/.asmltr/ivy-context/helpers/email-thread-mute.json
 * Override: ASMLTR_EMAIL_THREAD_MUTE
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function defaultThreadMutePath() {
  if (process.env.ASMLTR_EMAIL_THREAD_MUTE) return process.env.ASMLTR_EMAIL_THREAD_MUTE;
  return path.join(os.homedir(), '.asmltr', 'ivy-context', 'helpers', 'email-thread-mute.json');
}

function normAddr(a) {
  return String(a || '').trim().toLowerCase();
}

function emailDomain(addr) {
  const a = normAddr(addr);
  const i = a.lastIndexOf('@');
  return i >= 0 ? a.slice(i + 1) : '';
}

function isStaffOrSelf(addr, ownerAddr, selfAddr) {
  const a = normAddr(addr);
  if (!a) return false;
  const owner = normAddr(ownerAddr);
  const self = normAddr(selfAddr);
  if (a === owner || (self && a === self)) return true;
  const staff = emailDomain(owner);
  return !!(staff && emailDomain(a) === staff);
}

function extractEmails(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) {
    const out = [];
    const seen = new Set();
    for (const x of v) {
      for (const a of extractEmails(x)) {
        if (seen.has(a)) continue;
        seen.add(a);
        out.push(a);
      }
    }
    return out;
  }
  const out = [];
  const seen = new Set();
  const re = /[^\s<>,;]+@[^\s<>,;]+/g;
  let m;
  const s = String(v);
  while ((m = re.exec(s))) {
    const a = m[0].replace(/[<>]/g, '').toLowerCase();
    if (!a.includes('@') || seen.has(a)) continue;
    seen.add(a);
    out.push(a);
  }
  return out;
}

function canonSubject(s) {
  return String(s || '')
    .replace(/^\s*((re|fwd|fw)\s*:\s*)+/ig, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function threadIdFromKey(convKey) {
  const s = String(convKey || '');
  const m = s.match(/thread:([0-9a-f]{8,})$/i);
  return m ? m[1].toLowerCase() : '';
}

function loadThreadMutes(filePath) {
  const p = filePath || defaultThreadMutePath();
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const list = Array.isArray(raw) ? raw : (raw && raw.mutes);
    if (!Array.isArray(list)) return [];
    return list.filter((m) => m && m.enabled !== false);
  } catch (_) {
    return [];
  }
}

function rowThreadHit(row, subject, convKey) {
  const ids = (row.thread_ids || []).map((x) => String(x).toLowerCase()).filter(Boolean);
  const tid = threadIdFromKey(convKey);
  if (tid && ids.includes(tid)) return true;
  const want = (row.subjects || []).map(canonSubject).filter(Boolean);
  if (!want.length) return false;
  const got = canonSubject(subject);
  if (!got) return false;
  return want.some((s) => got === s || got.includes(s) || s.includes(got));
}

function rowAddrHit(row, addrs) {
  const want = (row.addrs || []).map(normAddr).filter(Boolean);
  if (!want.length) return true;
  const pool = new Set((addrs || []).map(normAddr).filter(Boolean));
  return want.some((a) => pool.has(a));
}

function rowHasScope(row) {
  return !!(
    (row.addrs && row.addrs.length)
    || (row.subjects && row.subjects.length)
    || (row.thread_ids && row.thread_ids.length)
  );
}

/**
 * @returns {null | { id: string, skipInbound: boolean, skipOutbound: boolean }}
 */
function matchThreadMute(opts) {
  const o = opts || {};
  const mutes = Array.isArray(o.mutes) ? o.mutes.filter((m) => m && m.enabled !== false) : loadThreadMutes(o.filePath);
  const fromAddr = normAddr(o.fromAddr);
  const recipients = [
    ...extractEmails(o.to),
    ...extractEmails(o.cc),
  ];
  const ownerAddr = o.ownerAddr;
  const selfAddr = o.selfAddr;
  for (const row of mutes) {
    if (!rowHasScope(row)) continue;
    const hasThread = !!(row.subjects && row.subjects.length) || !!(row.thread_ids && row.thread_ids.length);
    const hasAddr = !!(row.addrs && row.addrs.length);
    const threadOk = hasThread ? rowThreadHit(row, o.subject, o.convKey) : true;
    if (hasThread && !threadOk) continue;

    const fromOk = !fromAddr || rowAddrHit(row, [fromAddr]);
    const recipOk = rowAddrHit(row, recipients);
    const customerInbound = fromAddr && !isStaffOrSelf(fromAddr, ownerAddr, selfAddr) && fromOk && threadOk;
    const customerOutbound = recipients.some((a) => !isStaffOrSelf(a, ownerAddr, selfAddr)) && recipOk && threadOk;

    if (!customerInbound && !customerOutbound) {
      if (hasThread && threadOk && fromAddr && isStaffOrSelf(fromAddr, ownerAddr, selfAddr)) {
        return {
          id: String(row.id || 'thread-mute'),
          skipInbound: false,
          skipOutbound: false,
          closed: true,
        };
      }
      continue;
    }
    if (hasAddr && !fromOk && !recipOk) continue;

    return {
      id: String(row.id || 'thread-mute'),
      skipInbound: !!customerInbound,
      skipOutbound: !!customerOutbound,
      closed: true,
    };
  }
  return null;
}

function matchThreadMuteOutbound(payload, opts) {
  const p = payload || {};
  return matchThreadMute(Object.assign({}, opts || {}, {
    to: p.to,
    cc: p.cc,
    subject: p.subject,
    convKey: p.conversation_key || p.convKey,
  }));
}

module.exports = {
  defaultThreadMutePath,
  loadThreadMutes,
  canonSubject,
  threadIdFromKey,
  matchThreadMute,
  matchThreadMuteOutbound,
  isStaffOrSelf,
};
