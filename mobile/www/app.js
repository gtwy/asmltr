'use strict';
/*
 * asmltr mobile assistant — voice + keyboard client for the `android` connector.
 * Overlay mode (?overlay=1): a floating glass card over any app — draggable, minimizable, closeable,
 * continuous-listening, with a Stop that aborts the running turn + readout.
 */
const CFG_KEY = 'asmltr.mobile.cfg';
const $ = (id) => document.getElementById(id);
const OVERLAY = /(?:^|[?&#])overlay(?:=1)?(?:$|[&#])/.test(location.search + location.hash);

const ICON = {
  mic: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V22h2v-3.08A7 7 0 0 0 19 12h-2z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="3"/></svg>',
};

function loadCfg() {
  let c = {};
  try { c = JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch (_) {}
  const d = window.ASMLTR_DEFAULTS || {};
  const nc = window.__ASMLTR_NATIVE_CFG || {};
  c.baseUrl = (c.baseUrl || nc.baseUrl || d.baseUrl || '').replace(/\/+$/, '');
  c.token = c.token || nc.token || d.token || '';
  c.name = c.name || nc.name || d.agentName || 'My device';
  c.agentName = c.agentName || nc.agentName || d.agentName || 'assistant';
  if (!c.deviceId) c.deviceId = 'dev-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  return c;
}
function saveCfg(c) { localStorage.setItem(CFG_KEY, JSON.stringify(c)); }

let cfg = loadCfg();
let es = null, reconnectT = null;
let state = 'idle';              // 'idle' | 'rec' | 'busy'
let recorder = null, chunks = [], stream = null, heardSpeech = false;
let curBubble = null, stepsEl = null;
let drone = null, curAudio = null, vadRAF = 0, vadCtx = null;
let continuous = OVERLAY, suppressRestart = false;

// ---------- branding ----------
function toRGB(hex) { const m = String(hex).match(/#?([0-9a-fA-F]{6})/); if (!m) return null; const n = parseInt(m[1], 16); return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`; }
async function applyTheme() {
  try {
    const r = await fetch(cfg.baseUrl + '/gw/theme'); const j = await r.json();
    if (j.agentName) { cfg.agentName = j.agentName; $('agentName').textContent = j.agentName; }
    const hexes = String(j.palette || '').match(/#[0-9a-fA-F]{6}/g) || [];
    const a = hexes[0] && toRGB(hexes[0]), b = (hexes[1] && toRGB(hexes[1])) || a;
    if (a) { document.documentElement.style.setProperty('--accent', a); document.documentElement.style.setProperty('--accent2', b); }
  } catch (_) {}
}

// ---------- UI ----------
function setStatus(s, cls) { const el = $('status'); if (el) { el.textContent = s; el.className = 'pill ' + cls; } }
function bubble(role, text) {
  const el = document.createElement('div'); el.className = 'msg-row ' + role;
  const b = document.createElement('div'); b.className = 'bubble'; b.textContent = text || '';
  el.appendChild(b); $('log').appendChild(el); $('log').scrollTop = $('log').scrollHeight; return b;
}
function ensureSteps() { if (stepsEl) return stepsEl; const el = document.createElement('div'); el.className = 'steps'; $('log').appendChild(el); stepsEl = el; return el; }
function addStep(kind, text) {
  const s = ensureSteps(); const d = document.createElement('div'); d.className = 'step step-' + kind;
  d.textContent = (kind === 'tool' ? '⚙ ' : '… ') + text; s.appendChild(d); $('log').scrollTop = $('log').scrollHeight;
}
function setState(s) {
  state = s;
  const t = $('talk'), icon = $('talkIcon'), l = $('talkLabel');
  if (!t) return;
  t.className = 'talk' + (s === 'rec' ? ' rec' : s === 'busy' ? ' busy' : '');
  if (icon) icon.innerHTML = s === 'busy' ? ICON.stop : ICON.mic;
  if (l) l.textContent = s === 'rec' ? 'Listening…' : s === 'busy' ? 'Stop' : 'Tap to talk';
}

// ---------- SSE ----------
function connect() {
  if (!cfg.baseUrl || !cfg.token) { openSheet('Paste your device token to connect.'); return; }
  if (es) { es.close(); es = null; }
  setStatus('connecting…', 'pill-warn');
  const url = `${cfg.baseUrl}/gw/stream?token=${encodeURIComponent(cfg.token)}&device=${encodeURIComponent(cfg.deviceId)}&name=${encodeURIComponent(cfg.name)}`;
  es = new EventSource(url);
  es.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.type === 'ready') { setStatus('connected', 'pill-on'); maybeAssistLaunch(); }
    else if (m.type === 'thinking') addStep('think', m.text);
    else if (m.type === 'tool') addStep('tool', m.name);
    else if (m.type === 'delta') { stopDrone(); if (!curBubble) curBubble = bubble('assistant', ''); curBubble.textContent += m.text; $('log').scrollTop = $('log').scrollHeight; }
    else if (m.type === 'done') { stopDrone(); const full = curBubble ? curBubble.textContent : ''; curBubble = null; stepsEl = null; setState('idle'); if (full.trim()) speak(full).then(afterReply); else afterReply(); }
    else if (m.type === 'inject') { stepsEl = null; bubble('assistant', m.text); if (m.text && m.text.trim()) speak(m.text); }
    else if (m.type === 'error') { stopDrone(); bubble('sys', '⚠ ' + m.error); setState('idle'); }
  };
  es.onerror = () => { setStatus('reconnecting…', 'pill-warn'); if (es) { es.close(); es = null; } clearTimeout(reconnectT); reconnectT = setTimeout(connect, 2500); };
}
function afterReply() { if (continuous && !suppressRestart && state === 'idle') setTimeout(() => { if (continuous && !suppressRestart && state === 'idle') startRec(); }, 350); }

// ---------- turn ----------
async function api(path, body) {
  const r = await fetch(cfg.baseUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: cfg.token, device: cfg.deviceId, name: cfg.name, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
async function sendTurn(text) {
  if (state === 'busy') return;   // never overload a second turn onto the session
  suppressRestart = false;
  bubble('user', text); setState('busy');
  chime(); startDrone(); ack();
  try { await api('/gw/turn', { text }); }
  catch (e) { stopDrone(); bubble('sys', '⚠ ' + e.message); setState('idle'); }
}

// ---------- STOP: abort the running turn + kill the readout ----------
function stopEverything() {
  suppressRestart = true;
  stopDrone(); stopAudio();
  try { api('/gw/abort', {}).catch(() => {}); } catch (_) {}
  curBubble = null; stepsEl = null;
  setState('idle');
}

// ---------- audio ----------
function playClip(src, vol) { return new Promise((res) => { try { const a = new Audio(src); a.volume = vol == null ? 1 : vol; curAudio = a; a.onended = a.onerror = () => { if (curAudio === a) curAudio = null; res(); }; a.play().catch(() => res()); } catch (_) { res(); } }); }
function stopAudio() { try { if (curAudio) { curAudio.pause(); curAudio = null; } } catch (_) {} }
function chime() { playClip('assets/chime.ogg', 0.8); }
function startDrone() { try { if (!drone) { drone = new Audio('assets/drone.ogg'); drone.loop = true; drone.volume = 0.45; } drone.currentTime = 0; drone.play().catch(() => {}); } catch (_) {} }
function stopDrone() { try { if (drone) drone.pause(); } catch (_) {} }
const ACKS = ['On it.', 'One moment.', 'Let me look.', 'Sure — checking.'];
async function ack() { try { const t = ACKS[Math.floor(Date.now() / 500) % ACKS.length]; const { b64, mime } = await api('/gw/tts', { text: t }); if (state === 'busy') await playClip('data:' + (mime || 'audio/mpeg') + ';base64,' + b64, 0.9); } catch (_) {} }
async function speak(text) { try { const { b64, mime } = await api('/gw/tts', { text }); if (!suppressRestart) await playClip('data:' + (mime || 'audio/mpeg') + ';base64,' + b64); } catch (_) {} }

// ---------- record + VAD ----------
async function startRec() {
  if (state !== 'idle') return;   // no recording while a turn is in flight
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');
    recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    chunks = []; heardSpeech = false;
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = onRecStop; recorder.start(); setState('rec'); startVAD(stream);
  } catch (e) { bubble('sys', '⚠ mic: ' + e.message); setState('idle'); }
}
function stopRec() { stopVAD(); try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (_) {} }
async function onRecStop() {
  stopVAD(); try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
  // No speech detected → do nothing (don't fire an empty turn when you tap off without talking).
  if (!heardSpeech) { setState('idle'); return; }
  const blob = new Blob(chunks, { type: (recorder && recorder.mimeType) || 'audio/webm' });
  if (blob.size < 1200) { setState('idle'); return; }
  setState('busy');
  try {
    const b64 = await blobB64(blob);
    const { text } = await api('/gw/transcribe', { audio_base64: b64, mime: (recorder && recorder.mimeType) || 'audio/webm' });
    if (text && text.trim()) { setState('idle'); await sendTurn(text.trim()); } else setState('idle');
  } catch (e) { bubble('sys', '⚠ ' + e.message); setState('idle'); }
}
function startVAD(mediaStream) {
  try {
    vadCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = vadCtx.createMediaStreamSource(mediaStream);
    const an = vadCtx.createAnalyser(); an.fftSize = 1024; src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    const t0 = Date.now(); let floor = 0.01, floorN = 0, quietSince = 0;
    const rms = () => { an.getByteTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; s += v * v; } return Math.sqrt(s / buf.length); };
    const tick = () => {
      const level = rms(); const now = Date.now(); const dt = now - t0;
      if (dt < 350) { floor = (floor * floorN + level) / (floorN + 1); floorN++; vadRAF = requestAnimationFrame(tick); return; }
      const speaking = level > Math.max(0.03, floor * 2.2 + 0.012);
      if (speaking) { heardSpeech = true; quietSince = 0; }
      else if (heardSpeech) { if (!quietSince) quietSince = now; else if (now - quietSince > 900) { stopRec(); return; } }
      else if (dt > 7000) { stopRec(); return; }   // no speech → give up
      vadRAF = requestAnimationFrame(tick);
    };
    vadRAF = requestAnimationFrame(tick);
  } catch (_) {}
}
function stopVAD() { if (vadRAF) cancelAnimationFrame(vadRAF); vadRAF = 0; try { if (vadCtx) { vadCtx.close(); vadCtx = null; } } catch (_) {} }
function blobB64(blob) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); }); }

// ---------- assist launch ----------
function maybeAssistLaunch() { const a = OVERLAY || location.hash.indexOf('assist') >= 0 || window.__ASMLTR_ASSIST === true; if (a && state === 'idle') { window.__ASMLTR_ASSIST = false; setTimeout(() => { if (state === 'idle') startRec(); }, 250); } }
window.asmltrStartListening = () => { if (state === 'idle') startRec(); };

// ---------- overlay chrome: drag / minimize / close ----------
function initOverlayChrome() {
  const card = $('card'), handle = $('grip'); if (!card || !handle) return;
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false; const pos = { x: 0, y: 0 };
  const down = (e) => { if (e.target.closest('button')) return; dragging = true; const p = e.touches ? e.touches[0] : e; sx = p.clientX; sy = p.clientY; ox = pos.x; oy = pos.y; };
  const move = (e) => { if (!dragging) return; const p = e.touches ? e.touches[0] : e; pos.x = ox + (p.clientX - sx); pos.y = oy + (p.clientY - sy); card.style.transform = `translate(calc(-50% + ${pos.x}px), ${pos.y}px)`; e.preventDefault(); };
  const up = () => { dragging = false; };
  handle.addEventListener('mousedown', down); handle.addEventListener('touchstart', down, { passive: true });
  window.addEventListener('mousemove', move); window.addEventListener('touchmove', move, { passive: false });
  window.addEventListener('mouseup', up); window.addEventListener('touchend', up);
  $('min').addEventListener('click', () => { document.body.classList.add('minimized'); if (state === 'rec') stopRec(); });
  $('minbubble').addEventListener('click', () => { document.body.classList.remove('minimized'); if (continuous && state === 'idle') startRec(); });
  $('close').addEventListener('click', () => { stopEverything(); try { if (window.AsmltrOverlay && window.AsmltrOverlay.close) window.AsmltrOverlay.close(); } catch (_) {} });
}

// ---------- settings ----------
function openSheet(msg) { $('cfgUrl').value = cfg.baseUrl; $('cfgToken').value = cfg.token; $('cfgName').value = cfg.name; $('cfgDevice').value = cfg.deviceId; $('cfgMsg').textContent = msg || ''; $('sheet').classList.remove('hidden'); }
function closeSheet() { $('sheet').classList.add('hidden'); }
async function testConn() { const base = $('cfgUrl').value.trim().replace(/\/+$/, ''); $('cfgMsg').textContent = 'testing…'; try { const r = await fetch(base + '/health'); const j = await r.json(); $('cfgMsg').textContent = j.status === 'ok' ? '✓ reachable' : 'unexpected'; } catch (e) { $('cfgMsg').textContent = '✗ ' + e.message; } }

// ---------- wire up ----------
function init() {
  if (OVERLAY) { document.documentElement.style.background = 'transparent'; document.body.classList.add('overlay'); initOverlayChrome(); }
  $('agentName').textContent = cfg.agentName || 'assistant';
  $('talkIcon').innerHTML = ICON.mic;
  $('talk').addEventListener('click', () => { if (state === 'rec') stopRec(); else if (state === 'busy') stopEverything(); else startRec(); });
  $('settingsBtn').addEventListener('click', () => openSheet());
  $('cfgTest').addEventListener('click', testConn);
  $('cfgSave').addEventListener('click', () => {
    cfg.baseUrl = $('cfgUrl').value.trim().replace(/\/+$/, ''); cfg.token = $('cfgToken').value.trim(); cfg.name = $('cfgName').value.trim() || 'My device'; saveCfg(cfg);
    try { if (window.AsmltrNative && window.AsmltrNative.saveConfig) window.AsmltrNative.saveConfig(cfg.baseUrl, cfg.token, cfg.name); } catch (_) {}
    closeSheet(); applyTheme(); connect();
  });
  $('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeSheet(); });
  const send = () => { const v = $('kbd').value.trim(); if (!v || state === 'busy') return; $('kbd').value = ''; sendTurn(v); };
  $('kbdSend').addEventListener('click', send);
  $('kbd').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  applyTheme(); connect();
}
document.addEventListener('DOMContentLoaded', init);
