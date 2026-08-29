'use strict';
/**
 * Voice module for the Discord connector — runs on the SAME bot/gateway as text
 * (the owner's call: one bot, one token). @discordjs/voice is lazy-loaded so an audio-dep
 * failure can't take down the text path; all callers wrap in try/catch.
 *
 * v1: join a channel + play a soft chime. Per-user audio receive → STT → transcript →
 * Haiku gatekeeper land in the next increments.
 */
const path = require('path');

const rt = require('../../../shared/speech/realtime-stt'); // shared streaming STT (server-VAD turn-taking, #140)

const CHIME = path.join(__dirname, 'assets', 'chime.ogg');
const DRONE = path.join(__dirname, 'assets', 'drone.ogg');
let V = null;
const lib = () => (V || (V = require('@discordjs/voice')));
const connections = new Map(); // guildId -> VoiceConnection
// Realtime STT sessions, one per speaker: '<guildId>:<userId>' -> { session, name, subscribed, idleTimer }.
// Kept open across short pauses (server-VAD segments turns); idle-closed after prolonged silence.
const rtSessions = new Map();
const rtKey = (g, u) => g + ':' + u;
const SILENCE_700MS = Buffer.alloc(Math.round(24000 * 0.7) * 2); // trailing silence to flush a pending turn
const dronePlayers = new Map(); // guildId -> looping "working" drone player
// Active spoken-reply session per guild → makes a reply CANCELLABLE (barge-in / spoken "stop", #138).
// { cancelled:bool, player:AudioPlayer|null }. speak() no-ops once cancelled, so queued sentences after a
// barge-in never play; stopSpeech() also stops the sentence playing right now.
const speech = new Map(); // guildId -> { cancelled, player }

async function joinChannel(voiceChannel) {
  const { joinVoiceChannel, entersState, VoiceConnectionStatus } = lib();
  const prior = connections.get(voiceChannel.guild.id);
  if (prior) { try { prior.destroy(); } catch (_) {} }
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: false, // must NOT be deaf — we receive audio for STT
    selfMute: false, // must NOT be muted — we speak (chime / TTS)
  });
  await entersState(connection, VoiceConnectionStatus.Ready, 20000);
  connections.set(voiceChannel.guild.id, connection);
  return connection;
}

async function playChime(guildId) {
  const conn = connections.get(guildId);
  if (!conn) return null;
  const { createAudioPlayer, createAudioResource, NoSubscriberBehavior } = lib();
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  player.play(createAudioResource(CHIME));
  conn.subscribe(player);
  return player;
}

// --- listening: per-user audio → PCM → transcribe(WAV) → onUtterance -----------
const listening = new Set(); // guildIds currently listening

// wrap raw 48kHz stereo s16le PCM in a minimal WAV container for the STT API
function pcmToWav(pcm, rate = 48000, channels = 2) {
  const h = Buffer.alloc(44);
  const byteRate = rate * channels * 2, blockAlign = channels * 2;
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(byteRate, 28); h.writeUInt16LE(blockAlign, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// RMS amplitude of 16-bit PCM — used to skip near-silent chunks. Discord's VAD flags
// brief noises as "speech"; handed near-silence, STT models hallucinate "." / stray chars.
function rmsInt16(buf) {
  const n = buf.length >> 1; if (!n) return 0;
  let sum = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) { const s = buf.readInt16LE(i); sum += s * s; }
  return Math.sqrt(sum / n);
}
// Reject transcripts with no real content (pure punctuation / a single stray char).
function meaningful(t) {
  if (!t) return false;
  return t.replace(/[\s\p{P}\p{S}]/gu, '').length >= 2;
}

// Stream one speaker's audio into a persistent realtime STT session (#140). Opened lazily, kept open
// across short pauses so server-VAD segments turns; flushed with trailing silence when a burst ends;
// idle-closed after prolonged silence. onFinal → onUtterance; deltas → onPartial (live captions).
function realtimeSpeaking(guildId, client, userId, receiver, { onUtterance, onPartial, model, live, endpointMs, log }) {
  const { EndBehaviorType } = lib();
  const prism = require('prism-media');
  const key = rtKey(guildId, userId);
  let entry = rtSessions.get(key);
  if (!entry) {
    const u = client.users.cache.get(userId);
    const name = (u && (u.globalName || u.username)) || userId;
    log(`realtime: opening session for ${name} (${userId}) model=${model} live=${live}`);
    const session = rt.openSession({
      onOpen: () => log(`realtime: session OPEN for ${name}`),
      onPartial: (t) => { if (onPartial) { try { onPartial(name, t); } catch (_) {} } },
      onFinal: (t) => { log(`realtime FINAL(${name}): ${String(t).slice(0, 60)}`); if (t && onUtterance) { try { onUtterance(name, t, { confidence: 1, realtime: true, userId }); } catch (_) {} } },
      onError: (e) => log(`realtime stt ERROR: ${e}`),
    }, { model, live }); // live streaming model → partials during speech + commit finalizes; else server-VAD
    entry = { session, name, live, subscribed: false, idleTimer: null, burstFrames: 0 };
    rtSessions.set(key, entry);
  }
  if (entry.subscribed) return; // already streaming this burst
  entry.subscribed = true;
  entry.burstFrames = 0;
  clearTimeout(entry.idleTimer);
  const opus = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: Number.isFinite(endpointMs) ? endpointMs : 800 } });
  const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
  opus.on('error', (e) => log(`realtime opus err: ${e.message}`)); decoder.on('error', (e) => log(`realtime decode err: ${e.message}`));
  opus.pipe(decoder);
  decoder.on('data', (c) => { entry.burstFrames++; if (entry.burstFrames === 1) log(`realtime: first audio frame from ${entry.name}`); try { entry.session.pushPcm24(rt.pcm48StereoToPcm24Mono(c)); } catch (e) { log(`realtime push err: ${e.message}`); } });
  decoder.on('end', () => {
    entry.subscribed = false;
    // End-of-speech (Discord VAD). Live model → commit the buffer (flushes the tail + emits the clean
    // final). Server-VAD model → push trailing silence so the server finalizes the pending turn.
    // Guard tiny bursts (<~120ms) — the realtime API rejects a near-empty commit.
    if (entry.burstFrames >= 6) {
      log(`realtime: burst end for ${entry.name} (${entry.burstFrames} frames) — ${entry.live ? 'commit' : 'flush'}`);
      try { if (entry.live) entry.session.commit(); else entry.session.pushPcm24(SILENCE_700MS); } catch (_) {}
    }
    entry.idleTimer = setTimeout(() => { try { entry.session.close(); } catch (_) {} rtSessions.delete(key); }, 25000);
  });
}

// Close + drop every realtime session for a guild (on stop-listening / leave).
function closeRealtime(guildId) {
  for (const [k, e] of rtSessions) {
    if (k.startsWith(guildId + ':')) { try { clearTimeout(e.idleTimer); e.session.close(); } catch (_) {} rtSessions.delete(k); }
  }
}

// transcribe = async (wavBuffer) -> text | { text, confidence } ; onUtterance = (name, text, meta) => {}
// onBargeIn = (userId) => {}  — fired the instant a human starts speaking WHILE the bot is mid-reply.
// onPartial = (name, text) => {}  — live streaming caption (realtime mode only). Optional.
// realtime = true → stream to the shared realtime STT (server-VAD turns); false → batch per-utterance.
function startListening(guildId, client, { transcribe, onUtterance, onBargeIn, onPartial, realtime, realtimeModel, realtimeLive, vad = {}, log = () => {} }) {
  const conn = connections.get(guildId);
  if (!conn) return false;
  const { EndBehaviorType } = lib();
  const prism = require('prism-media');
  const receiver = conn.receiver;
  const active = new Set(); // userIds mid-capture (avoid double-subscribe)
  // Shared VAD tunables (#141): end-of-speech silence + the near-silent RMS gate come from stt.config
  // (Settings → Voice), so Discord turn-taking tunes identically to the app instead of a hard-coded 1s.
  const endpointMs = Number.isFinite(vad.endpointMs) ? vad.endpointMs : 1000;
  const rmsGate = Number.isFinite(vad.rmsGate) ? vad.rmsGate : 300;
  listening.add(guildId);

  receiver.speaking.on('start', (userId) => {
    if (!listening.has(guildId)) return;
    // Barge-in: the bot only ever RECEIVES other humans (never its own playback), so any speech that
    // starts while a reply is playing is someone talking over it → interrupt. The handler debounces.
    if (onBargeIn && isSpeaking(guildId)) { try { onBargeIn(userId); } catch (_) {} }
    if (realtime) { realtimeSpeaking(guildId, client, userId, receiver, { onUtterance, onPartial, model: realtimeModel || 'gpt-live-transcribe', live: realtimeLive !== false, endpointMs, log }); return; }
    if (active.has(userId)) return;
    active.add(userId);
    const opus = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: endpointMs } });
    const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
    const chunks = [];
    opus.on('error', () => {}); decoder.on('error', () => {});
    opus.pipe(decoder);
    decoder.on('data', (c) => chunks.push(c));
    decoder.on('end', async () => {
      active.delete(userId);
      const pcm = Buffer.concat(chunks);
      if (pcm.length < 48000 * 2 * 2 * 0.3) return; // < ~0.3s → too short (still keeps a crisp wake word)
      if (rmsInt16(pcm) < rmsGate) return;          // near-silent → skip (shared vad_sensitivity gate)
      try {
        const res = await transcribe(pcmToWav(pcm));
        const text = ((typeof res === 'string' ? res : (res && res.text)) || '').trim();
        const confidence = (res && typeof res === 'object' && typeof res.confidence === 'number') ? res.confidence : undefined;
        if (!meaningful(text)) return;              // drop ".", single chars, empty
        const u = client.users.cache.get(userId);
        const name = (u && (u.globalName || u.username)) || userId;
        onUtterance(name, text, { confidence, userId });
      } catch (e) { log(`stt failed: ${e.message}`); }
    });
  });
  return true;
}

// Mark the start of a cancellable spoken reply. Call before streaming sentences into speak().
function startSpeech(guildId) { speech.set(guildId, { cancelled: false, player: null }); }
// Is a (non-cancelled) reply currently speaking? Used to decide barge-in.
function isSpeaking(guildId) { const s = speech.get(guildId); return !!(s && !s.cancelled); }
// Hard-cancel the current reply: stop the sentence playing now AND make queued sentences no-op.
function stopSpeech(guildId) {
  const s = speech.get(guildId);
  if (s) { s.cancelled = true; try { s.player && s.player.stop(true); } catch (_) {} }
  speech.delete(guildId);
}
// Normal end of a reply (all sentences spoken) — clear the session without cancelling.
function endSpeech(guildId) { speech.delete(guildId); }

// speak an mp3 (e.g. ElevenLabs TTS) into the channel; resolves when playback ends. Honors the
// cancellable speech session: if the reply was barged-in/stopped, this no-ops so the queue drains silently.
async function speak(guildId, mp3Buffer) {
  const conn = connections.get(guildId);
  if (!conn) return null;
  const s = speech.get(guildId);
  if (!s || s.cancelled) return null; // no active reply session (stopped/deleted) or cancelled → don't play
  const { createAudioPlayer, createAudioResource, NoSubscriberBehavior, entersState, AudioPlayerStatus } = lib();
  const { Readable } = require('stream');
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  if (s) s.player = player;
  player.play(createAudioResource(Readable.from(mp3Buffer)));
  conn.subscribe(player);
  try {
    await entersState(player, AudioPlayerStatus.Playing, 5000);
    await entersState(player, AudioPlayerStatus.Idle, 120000);
  } catch (_) {}
  try { player.stop(); } catch (_) {}
  if (s && s.player === player) s.player = null;
  return player;
}

function stopListening(guildId) { listening.delete(guildId); closeRealtime(guildId); }

// Soft looping "I'm working on it" drone — played while a turn is being generated, so the
// speaker knows something is happening between the chime and the spoken reply.
function startDrone(guildId) {
  const conn = connections.get(guildId);
  if (!conn) return;
  stopDrone(guildId);
  const { createAudioPlayer, createAudioResource, NoSubscriberBehavior, AudioPlayerStatus } = lib();
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  const loop = () => { try { player.play(createAudioResource(DRONE)); } catch (_) {} };
  player.on(AudioPlayerStatus.Idle, loop); // re-play on end → loops until stopped
  player.on('error', () => {});
  loop();
  conn.subscribe(player);
  dronePlayers.set(guildId, player);
}
function stopDrone(guildId) {
  const p = dronePlayers.get(guildId);
  if (!p) return;
  try { p.removeAllListeners(); p.stop(true); } catch (_) {}
  dronePlayers.delete(guildId);
}

function leave(guildId) {
  const c = connections.get(guildId);
  if (!c) return false;
  stopListening(guildId);
  try { c.destroy(); } catch (_) {}
  connections.delete(guildId);
  return true;
}

const isConnected = (guildId) => connections.has(guildId);
const isListening = (guildId) => listening.has(guildId);
function channelIdOf(guildId) {
  const c = connections.get(guildId);
  if (!c) return null;
  return (c.joinConfig && c.joinConfig.channelId) || null;
}

module.exports = {
  joinChannel, playChime, speak, leave, isConnected, isListening, channelIdOf,
  startListening, stopListening, startDrone, stopDrone,
  startSpeech, stopSpeech, endSpeech, isSpeaking,
};
