'use strict';
/**
 * Still-generation ask. Discord Generating-chip and grok xhigh share this.
 * Not a tool allow — display + effort only.
 *
 * Forward: generate|make|draw|create|paint … kind (any words in between).
 * Reverse: kind … made|generated|drawn|drew|created|painted.
 * Same sentence only (no . ! ?). At most 12 tokens between so a later
 * "picture" in another clause does not fire.
 */

const VERB = 'generate|make|draw|create|paint';
const KIND = 'pictures?|images?|graphics?|cartoons?|paintings?|drawings?|photos?|photographs?|pics?|art';
const PAST = 'generated|made|drawn|drew|created|painted';
const MID = '(?:[^\\s.!?]+\\s+){0,12}';

const IMAGE_GEN_ASK_RE = new RegExp(
  '\\b(?:(?:' + VERB + ')\\s+' + MID + '(?:' + KIND + ')|(?:' + KIND + ')\\s+' + MID + '(?:' + PAST + '))\\b',
  'i'
);

function looksLikeImageGen(text) {
  return IMAGE_GEN_ASK_RE.test(String(text || ''));
}

module.exports = { looksLikeImageGen, IMAGE_GEN_ASK_RE };
