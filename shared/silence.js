'use strict';
/**
 * [[NO_REPLY]] is the universal silence sentinel (core handle(), Discord, persist).
 *
 * True only when the whole trimmed text is the token, or the last non-empty line
 * is the token (cross-channel redirect: work on another connector, then silence
 * here). A real reply that *mentions* the token must still send — a substring
 * match swallowed those.
 */

const SENTINEL_RE = /^\[\[NO_REPLY\]\]$/i;
const STRIP_RE = /\[\[NO_REPLY\]\]/gi;

function isNoReplySentinel(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (SENTINEL_RE.test(t)) return true;
  const lines = t.split(/\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    return SENTINEL_RE.test(line);
  }
  return false;
}

function stripNoReplySentinel(text) {
  return String(text || '').replace(STRIP_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Email reply-gate mails session text. Core's last-line [[NO_REPLY]] would otherwise
 * drop a letter that the extra used to tell the model to tag. Bare token still silences.
 * Other channels keep last-line as full silence (redirect / asmltr send).
 */
function emailKeepLetterDespiteSentinel(channel, text) {
  if (String(channel || '') !== 'email') return null;
  if (!isNoReplySentinel(text)) return null;
  const letter = stripNoReplySentinel(text);
  return letter || null;
}

/**
 * The model often prose-refuses instead of [[NO_REPLY]] ("that's addressed to
 * Markay, not me" / "I'll stay off this reply"). Treat a SHORT whole-body
 * refusal as silence so Discord does not post it and the email reply-gate
 * does not SMTP it. Length-capped. A Hi/Dear greeting means a letter — leave it.
 * Markay Outlook 11 Sep 2026: stay-off prose was the entire mailed body.
 */
const LETTER_OPEN = /^(?:dear|hi|hello|hey)\s+[A-Za-z][\w .'-]{0,40},?\s*$/i;
const NON_REPLY_RES = [
  /\bnot (?:addressed|meant|directed|intended)\s*(?:to|at|for)?\s*me\b/i,
  /\baddressed to \w+[, ]+not me\b/i,
  /\b(?:that(?:['’]s| is)?|this is|it['’]s) (?:addressed|meant|for|directed|intended) (?:to|for|at) \w+/i,
  /\bnothing (?:here )?for me to (?:add|say|respond|do|answer|reply)\b/i,
  /\bnot my (?:turn|message|place|call|cue)\b/i,
  /\bi['’]?ll (?:let|leave|defer to) \w+ (?:take|handle|answer|respond)\b/i,
  /\bno (?:reply|response) (?:needed|required|from me)\b/i,
  /\btalking to \w[\w .'-]{0,40},?\s+not (?:to )?me\b/i,
  /\bi['’]?ll stay off\b/i,
  /\bstay off this (?:reply|thread|chain|letter|one|email|mail)\b/i,
  /\bi(?:['’]ll| will) not (?:reply|respond)\b/i,
  /\bnot going to reply\b/i,
  /\bthis (?:one |message |mail |email )?(?:is )?(?:not|n['’]t) for me\b/i,
  /\bi(?:['’]ll| will) stay (?:silent|quiet|off)\b/i,
];

function looksLikeNonReply(t) {
  const s = String(t || '').trim();
  if (!s || s.length > 400) return false;
  for (const line of s.split('\n')) {
    if (LETTER_OPEN.test(line.trim())) return false;
  }
  return NON_REPLY_RES.some((re) => re.test(s));
}

module.exports = {
  isNoReplySentinel,
  stripNoReplySentinel,
  emailKeepLetterDespiteSentinel,
  looksLikeNonReply,
};
