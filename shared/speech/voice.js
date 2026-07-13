'use strict';
/**
 * asmltr core speech layer — voice UX helpers: the acknowledgment + ambient cues that mask the
 * agent's think time so a ~20s full-context turn doesn't feel like dead silence.
 *
 *   • chime  — instant "request received" ding (pre-recorded asset, zero latency)
 *   • drone  — soft ambient loop played WHILE the agent works, stopped when the real reply starts
 *   • ack    — an optional short spoken acknowledgment ("On it."), dashboard-toggleable, cached so
 *              it's effectively instant after first use
 *
 * The full agent still produces the real answer (no dumbed-down model); these just make the wait
 * feel responsive. Settings persist in the asmltr state dir so the dashboard toggle sticks.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const tts = require('./tts');

function stateDir() {
  const d = process.env.ASMLTR_STATE_DIR || path.join(os.homedir(), '.asmltr');
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
}
const ackFlag = () => path.join(stateDir(), 'voice-ack'); // '0' = disabled; anything else / missing = enabled (default ON)

function isAckEnabled() { try { return fs.readFileSync(ackFlag(), 'utf8').trim() !== '0'; } catch (_) { return true; } }
function setAckEnabled(on) { try { fs.writeFileSync(ackFlag(), on ? '1' : '0'); } catch (_) {} return isAckEnabled(); }

const ACK_PHRASES = (process.env.ASMLTR_VOICE_ACK_PHRASES
  ? process.env.ASMLTR_VOICE_ACK_PHRASES.split('|').map((s) => s.trim()).filter(Boolean)
  : ['On it.', 'Let me look into that.', 'One moment.', 'Sure, checking now.', 'Got it — working on it.']);
const _ackCache = new Map(); // phrase → { audio, mime }

/** A short spoken acknowledgment clip (random phrase, cached → instant after first use). */
async function getAckClip() {
  const phrase = ACK_PHRASES[Math.floor(Math.random() * ACK_PHRASES.length)];
  if (_ackCache.has(phrase)) return { phrase, ..._ackCache.get(phrase) };
  const { audio, mime } = await tts.synthesize(phrase);
  _ackCache.set(phrase, { audio, mime });
  return { phrase, audio, mime };
}

const ASSET_DIR = path.join(__dirname, 'assets');
const ASSET_MIME = { '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
/** Resolve a whitelisted cue asset (chime/drone) to { path, mime } or null. */
function asset(name) {
  const base = path.basename(String(name || ''));
  if (!/^[\w.-]+\.(ogg|mp3|wav)$/.test(base)) return null;
  const p = path.join(ASSET_DIR, base);
  if (!fs.existsSync(p)) return null;
  return { path: p, mime: ASSET_MIME[path.extname(base)] || 'application/octet-stream' };
}

module.exports = { isAckEnabled, setAckEnabled, getAckClip, asset, ACK_PHRASES };
