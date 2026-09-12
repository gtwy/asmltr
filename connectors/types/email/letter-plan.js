'use strict';
/**
 * Drop grok plan/thought glued above the letter (Battery Backups 24 Aug,
 * Markay Outlook 11 Sep). Prompt-only LETTER_ONLY_EXTRA missed again.
 *
 * Do not cut on a bare "James," / "Amazon," line (that is why 2deacfd
 * was replaced, then 5ec4406 reverted the I'll-send heuristic). Cut only:
 *   1. leading text above Hi/Hello/Hey/Dear Name
 *   2. leading Photo-is / I'll-send scratch paragraphs when a letter follows
 * One-paragraph letters and "I'll send the invoice tomorrow." stay.
 */
const LETTER_OPEN = /^(?:dear|hi|hello|hey)\s+[A-Za-z][\w .'-]{0,40},?\s*$/i;
const PLAN_CAPTION = /^(photos?|images?|pics?|screenshots?|attachments?)\s+(is|are|shows?)\b/i;
const CLOSING_LINE = /^(sincerely|thanks|thank you|best|cheers|regards|respectfully|cordially|warmly|best regards|kind regards),?$/i;

function looksLikeGreetingLine(line) {
  return LETTER_OPEN.test(String(line || '').trim());
}

function looksLikeInternalPlan(para) {
  const t = String(para || '').trim();
  if (!t) return false;
  if (PLAN_CAPTION.test(t)) return true;
  const n = (t.match(/\bI['’]ll\s+(send|flag|look|find|check|get|pull|attach)\b/gi) || []).length;
  if (n >= 2) return true;
  if (n === 1) {
    if (/\bplease\b/i.test(t)) return false;
    if (/^(dear|hi|hello|hey)\b/i.test(t)) return false;
    const compact = t.replace(/\s+/g, ' ');
    if (/^I['’]ll\s+send\s+[^.?]{1,60}\.?$/i.test(compact)) return false;
    return true;
  }
  return false;
}

function looksLikeClosingOnly(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return true;
  if (!CLOSING_LINE.test(lines[0])) return false;
  return lines.length <= 3;
}

function stripAtGreeting(text) {
  const raw = String(text || '');
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (CLOSING_LINE.test(t)) continue;
    if (!looksLikeGreetingLine(t)) continue;
    const before = lines.slice(0, i).join('\n').trim();
    if (!before) return raw.trim();
    return lines.slice(i).join('\n').trim();
  }
  return null;
}

function stripLeadingPlanParas(text) {
  const raw = String(text || '');
  const paras = raw.split(/\n\n+/);
  if (paras.length < 2) return raw.trim();
  let i = 0;
  while (i < paras.length - 1 && looksLikeInternalPlan(paras[i])) i += 1;
  if (i === 0) return raw.trim();
  const rest = paras.slice(i).join('\n\n').trim();
  if (!rest || looksLikeClosingOnly(rest)) return raw.trim();
  return rest;
}

function stripLeadingLetterPlan(text) {
  const raw = String(text || '');
  const fromGreeting = stripAtGreeting(raw);
  if (fromGreeting != null) return fromGreeting;
  return stripLeadingPlanParas(raw);
}

module.exports = {
  stripLeadingLetterPlan,
  looksLikeInternalPlan,
  looksLikeGreetingLine,
};
