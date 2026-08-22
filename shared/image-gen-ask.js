'use strict';
/**
 * Still-generation ask. Kind-word gate, then a YES/NO classify on the
 * moderation key (gpt-5-nano). Discord Generating-chip and grok xhigh consume
 * the verdict. Not a tool allow. Intent is NOT folded into moderate() today.
 *
 * Gate is the kind list only (picture/photo/image/…). No verb+kind regex.
 */

const KIND_RE = /\b(?:pictures?|images?|graphics?|cartoons?|paintings?|drawings?|photos?|photographs?|pics?)\b/i;

function mentionsImageKind(text) {
  return KIND_RE.test(String(text || ''));
}

function buildImageGenClassifyPrompt(text) {
  return [
    'Decide if the user wants a NEW still generated or an existing still edited this turn',
    '(draw, make, generate, composite, put someone into a photo, sit him on the bench in a photo, etc.).',
    'YES = they want image_gen or image_edit now.',
    'NO = they only mentioned a picture (talk about one, attach one, ask what is in a still,',
    'generate a report, "I liked the picture you made", "make sure this picture is posted").',
    'Reply with ONLY YES or NO on the first line.',
    '',
    String(text || '').slice(0, 4000),
  ].join('\n');
}

/** Fail closed (not a picture request) unless the reply leads with YES. */
function parseImageGenVerdict(out) {
  const s = String(out || '').replace(/[*_`#]+/g, ' ').trim();
  if (!s) return false;
  const head = s.split(/\n/)[0].trim();
  if (/^YES\b/i.test(head)) return true;
  if (/^NO\b/i.test(head)) return false;
  return false;
}

/**
 * @param {string} text
 * @param {(opts: object) => Promise<string>} completeFn engine.complete — caller supplies it
 *   so this file never imports an engine (no circular grok require).
 */
async function classifyImageGenAsk(text, completeFn) {
  if (!mentionsImageKind(text)) return false;
  if (typeof completeFn !== 'function') return false;
  try {
    const out = await completeFn({
      prompt: buildImageGenClassifyPrompt(text),
      appendSystemPrompt: 'You are ONLY a classifier. Reply YES or NO. No tools. No extra text.',
    });
    return parseImageGenVerdict(out);
  } catch (_) {
    return false;
  }
}

module.exports = {
  mentionsImageKind, buildImageGenClassifyPrompt, parseImageGenVerdict, classifyImageGenAsk, KIND_RE,
};
