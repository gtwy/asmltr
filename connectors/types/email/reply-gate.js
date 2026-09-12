'use strict';
/**
 * End-of-turn email delivery. Session `reply` is not raw-SMTP'd; a letter-shaped
 * body that never went through /out is mailed via buildOutPayload (same as asmltr send).
 * Skip silence, already-sent, always_draft, and ops matchers (never write the vendor).
 *
 * [[NO_REPLY]] (bare or last line) is silence — do not strip it and mail the rest.
 * Extra: write the letter with no sentinel. Token means stay quiet / already asmltr send.
 */
const { isNoReplySentinel, stripNoReplySentinel } = require('../../../shared/silence');
const { stripLeadingLetterPlan } = require('./letter-plan');

function letterBodyFromReply(text) {
  return stripLeadingLetterPlan(stripNoReplySentinel(text));
}

function emailReplyGateDecision(opts) {
  const o = opts || {};
  if (o.sendPolicy === 'always_draft') return { action: 'skip', reason: 'always_draft' };
  if (o.alreadyOut) return { action: 'skip', reason: 'already-out' };
  if (isNoReplySentinel(o.replyText)) return { action: 'skip', reason: 'no-letter' };
  const letter = letterBodyFromReply(o.replyText);
  if (!letter) return { action: 'skip', reason: 'no-letter' };
  if (o.opsHit) return { action: 'skip', reason: 'ops-noreply' };
  return { action: 'mail', text: letter };
}

module.exports = { letterBodyFromReply, emailReplyGateDecision };
