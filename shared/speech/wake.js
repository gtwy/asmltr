'use strict';
/**
 * shared/speech/wake.js — the ONE wake-word / direct-address matcher for every voice surface
 * (Discord voice, the Android app, the web PWA). Part of epic #135 (unify the voice layer).
 *
 * Two jobs, kept deterministic (no per-utterance model call):
 *   1. addresses(text, wakeWord)  — does this utterance address the assistant by name?
 *   2. evaluate({...})            — should it FIRE a turn? Adds a CONFIDENCE GATE so a fuzzy STT
 *                                   artifact that merely *looks* like the name can't trigger a reply.
 *
 * The false-trigger bug (#136, "the bot just talks"): batch STT occasionally mis-hears a word as the
 * assistant's name, the regex matches, and a turn dispatches. The fix is not a better regex — it's
 * refusing to fire on a LOW-CONFIDENCE match, especially a bare lone name with no following intent.
 * Confidence is a probability in [0,1] (derive it from STT logprobs; see stt.js `logprobs` opt).
 */

// Normalize for matching: lowercase, collapse whitespace, trim.
function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

// Regex-escape a raw name so it can be embedded in a pattern.
function esc(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// STT often hears "Ivy" as "IV" / "iv". Same person, word-boundary only (not "divine").
const IVY_ALIASES = Object.freeze(['ivy', 'iv']);

function wakeTerms(wakeWord) {
  const primary = norm(wakeWord);
  if (!primary) return [];
  const terms = [primary];
  if (primary === 'ivy') {
    for (const a of IVY_ALIASES) if (!terms.includes(a)) terms.push(a);
  }
  return terms;
}

function addressesOne(t, word) {
  const w = esc(word);
  if (!t || !w) return false;
  return new RegExp(`^(hey |hi |ok |okay |yo |so |well |um+ |uh+ |,|\\s)*${w}\\b`).test(t) // leads: "<name>, do X"
    || new RegExp(`\\b(hey|ok|okay|hi|yo) ${w}\\b`).test(t)                                 // "hey <name>" anywhere
    || new RegExp(`\\b${w}\\s*[,?!.]`).test(t)                                              // "<name>," / "<name>?" / "<name>!"
    || new RegExp(`\\b${w}\\b[\\s.?!,]*$`).test(t);                                         // trails: "do X, <name>"
}

/**
 * Does `text` address the assistant by `wakeWord`? Conservative on purpose (avoid interrupting):
 * the name has to LEAD, be greeted ("hey <name>"), be set off by punctuation, or TRAIL the sentence.
 * When the name is Ivy, also accept IV / iv (same person; word-boundary so "divine" does not match).
 */
function addresses(text, wakeWord) {
  const t = norm(text);
  if (!t) return false;
  return wakeTerms(wakeWord).some((w) => addressesOne(t, w));
}

// Is the utterance essentially JUST the name (name + greeting/filler/punctuation, no real request)?
// A bare lone name is the highest-risk false trigger, so it gets the strictest confidence gate.
function isBareName(text, wakeWord) {
  let stripped = norm(text)
    .replace(new RegExp(`\\b(hey|hi|ok|okay|yo|so|well|um+|uh+)\\b`, 'g'), ' ');
  for (const w of wakeTerms(wakeWord)) {
    stripped = stripped.replace(new RegExp(`\\b${esc(w)}\\b`, 'g'), ' ');
  }
  stripped = stripped.replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return stripped.length === 0;
}

// Count real words (used to decide how risky a match is).
function wordCount(text) { return norm(text).split(' ').filter(Boolean).length; }

// Map wake_sensitivity (0..100) → the minimum confidence a RISKY match must clear.
// High sensitivity → low bar (fires more, more false-accepts). Low sensitivity → high bar (strict).
//   sensitivity 0   → 0.80   ·   50 → ~0.53   ·   100 → 0.25
function minConfidenceForRisky(sensitivity) {
  const s = Math.max(0, Math.min(100, Number(sensitivity)));
  return +(0.80 - (s / 100) * 0.55).toFixed(3);
}

/**
 * Decide whether an utterance should FIRE a turn.
 * @param {object} o
 * @param {string} o.text         the transcript
 * @param {string} o.wakeWord     the assistant's spoken name / wake word
 * @param {number} [o.sensitivity=50]  wake_sensitivity 0..100
 * @param {number} [o.confidence]  STT confidence in [0,1]; omit/undefined if unknown
 * @returns {{addressed:boolean, bare:boolean, risky:boolean, confidence:(number|null),
 *            threshold:(number|null), reason:string}}
 */
function evaluate({ text, wakeWord, sensitivity = 50, confidence } = {}) {
  const conf = (typeof confidence === 'number' && Number.isFinite(confidence)) ? confidence : null;
  const base = { addressed: false, bare: false, risky: false, confidence: conf, threshold: null };
  if (!addresses(text, wakeWord)) return { ...base, reason: 'no-wake' };

  const bare = isBareName(text, wakeWord);
  const risky = bare || wordCount(text) <= 2; // short/lone matches are where false hits live
  if (!risky) return { ...base, addressed: true, reason: 'ok-clear' };

  const threshold = minConfidenceForRisky(sensitivity);
  if (conf === null) {
    // No confidence signal available: still refuse a bare lone name unless sensitivity is high,
    // since that's the classic mis-hear. A 2-word address is allowed through.
    if (bare && sensitivity < 60) return { ...base, addressed: false, bare, risky: true, reason: 'bare-name-no-confidence-signal' };
    return { ...base, addressed: true, bare, risky: true, reason: 'ok-risky-no-signal' };
  }
  if (conf < threshold) return { ...base, addressed: false, bare, risky: true, threshold, reason: 'low-confidence' };
  return { ...base, addressed: true, bare, risky: true, threshold, reason: 'ok-risky-confident' };
}

module.exports = { addresses, isBareName, wordCount, minConfidenceForRisky, evaluate, norm, wakeTerms, IVY_ALIASES };
