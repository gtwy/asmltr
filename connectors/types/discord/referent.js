'use strict';

/** Exact ask when the referent is not on this turn. No look-ahead wait. */
const ASK_MISSING_MEDIA =
  'Did you forget to attach the media, or could you be more specific about what you want me to look at?';

function referentPromptBlock() {
  return `
MISSING REFERENT (photos / "what is this"):
- If they ask what something is / what a photo is / to look at something, and this turn has no attached still (and the Discord reply is not to a still), do NOT hunt Recent uploads, gen-ref, other channels, or old files. Ask exactly: "${ASK_MISSING_MEDIA}"
- If they then attach media, look at THAT.
- If they say the media was already posted (look up, look above, right after the question): search THIS channel only for media that arrived AFTER that question. Not other rooms. Not older than the question.
- Deep-dive earlier in THIS thread only when they point at earlier context (last night, yesterday, a specific older message). That is the only photo-ID case where you go looking in history.
- Do not stall a turn waiting for an upload.`;
}

function shouldQueueLateMedia(slot, message) {
  if (!slot || !message) return false;
  const atts = message.attachments;
  const n = atts && (typeof atts.size === 'number' ? atts.size : (atts.length || 0));
  if (!n) return false;
  const authorId = message.author && message.author.id;
  if (!authorId || slot.starterId == null) return false;
  return String(slot.starterId) === String(authorId);
}

/** discord.js: reply to our message sets mentions.repliedUser. */
function isReplyToUs(message, botId) {
  if (!message || botId == null) return false;
  const replied = message.mentions && message.mentions.repliedUser;
  if (replied && String(replied.id) === String(botId)) return true;
  return false;
}

module.exports = { ASK_MISSING_MEDIA, referentPromptBlock, shouldQueueLateMedia, isReplyToUs };
