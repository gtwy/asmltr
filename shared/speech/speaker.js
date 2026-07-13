'use strict';
/**
 * asmltr core speech layer — the SPEAK pipeline.
 *
 * Converts the core's live reply token stream into voice with minimal time-to-first-word:
 *   onDelta tokens → buffer → flush on SENTENCE boundaries → TTS per sentence → ordered audio out.
 *
 * Because the agent writes its intermediary narration ("I'll check that folder…") as ordinary text
 * blocks in the same token stream, speaking the delta stream naturally voices the narration AND the
 * final answer, in order — no double-speak (we intentionally ignore `onThinking`, which is internal
 * reasoning, and `onSegment`, which is the block-level view of the same text the deltas carry).
 *
 * Sentences are synthesized as soon as they complete, so audio begins on the FIRST sentence rather
 * than the whole answer. Synthesis runs one-ahead (sentence N+1 renders while N is emitted) but audio
 * is always emitted in order, so playback is gapless and correctly sequenced.
 */
const ttsDefault = require('./tts');

// Strip the bits that don't belong in speech (markdown, code, URLs) so TTS reads cleanly. A proper
// "voice mode" system prompt (keep replies speakable) is the real fix; this is the safety net.
function cleanForSpeech(s) {
  return String(s || '')
    .replace(/```[\s\S]*?```/g, ' ')            // fenced code — never read aloud
    .replace(/`([^`]+)`/g, '$1')                 // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')       // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')     // links → link text
    .replace(/https?:\/\/\S+/g, 'link')          // bare URLs
    .replace(/[*_#>`~]+/g, '')                    // emphasis / heading / quote marks
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Create a speak pipeline.
 * @param {object} o
 * @param {(piece:{seq:number,text:string})=>void} [o.onText]   fired when a sentence is queued (transcript)
 * @param {(clip:{seq:number,audio:Buffer,mime:string,text:string,error?:string})=>void} o.onAudio  ordered audio out
 * @param {object} [o.tts]  TTS module override (for tests)
 * @param {number} [o.maxBuffer=240]  force-flush a run-on with no sentence boundary past this many chars
 */
function createSpeaker({ onText, onAudio, tts = ttsDefault, maxBuffer = 240 } = {}) {
  let buf = '';
  let seq = 0;
  let emitChain = Promise.resolve();   // serializes audio emission in sentence order
  const inflight = [];                 // all synth promises (so finish() can await them)

  function enqueue(raw) {
    const text = cleanForSpeech(raw);
    if (!text) return;
    const mySeq = seq++;
    if (onText) { try { onText({ seq: mySeq, text }); } catch (_) {} }
    // Kick off synthesis immediately (one-ahead), but emit strictly in order via the chain.
    const job = tts.synthesize(text)
      .then(({ audio, mime }) => ({ seq: mySeq, audio, mime, text }))
      .catch((e) => ({ seq: mySeq, error: e.message, text, audio: null, mime: null }));
    inflight.push(job);
    emitChain = emitChain.then(() => job).then((clip) => { if (onAudio) { try { onAudio(clip); } catch (_) {} } });
  }

  // Flush every COMPLETE sentence in the buffer, leaving any trailing partial for the next delta.
  function drainSentences() {
    const re = /[.!?…](?=\s|$)|\n+/g;   // sentence end (punct + boundary) or a hard line break
    let m, lastEnd = 0;
    while ((m = re.exec(buf))) {
      const end = m.index + m[0].length;
      enqueue(buf.slice(lastEnd, end));
      lastEnd = end;
    }
    buf = buf.slice(lastEnd);
    // Latency guard: a very long run-on with no punctuation shouldn't hold audio hostage.
    if (buf.length > maxBuffer) {
      const cut = buf.lastIndexOf(' ', maxBuffer);
      const at = cut > 40 ? cut : maxBuffer;
      enqueue(buf.slice(0, at));
      buf = buf.slice(at);
    }
  }

  return {
    /** Feed a token/delta of assistant text. */
    pushDelta(text) { if (!text) return; buf += text; drainSentences(); },
    /** Flush the trailing partial sentence and wait for ALL audio to be emitted, in order. */
    async finish() {
      if (buf.trim()) { enqueue(buf); buf = ''; }
      await Promise.allSettled(inflight);
      await emitChain;
    },
  };
}

module.exports = { createSpeaker, cleanForSpeech };
