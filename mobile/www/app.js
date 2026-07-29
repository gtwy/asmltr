'use strict';
/*
 * asmltr mobile assistant — voice + keyboard client for the `android` connector.
 * Streaming TTS (speaks as sentences arrive), clickable tool results, mute, and (overlay mode) a
 * draggable/minimizable/closeable glass card with continuous listening + a Stop that aborts turn + readout.
 */
const CFG_KEY = 'asmltr.mobile.cfg';
const $ = (id) => document.getElementById(id);
const OVERLAY = /(?:^|[?&#])overlay(?:=1)?(?:$|[&#])/.test(location.search + location.hash);
// native=1 → we're inside the persistent OverlayService window; min/expand drive the native window
// (so it survives swipe-home) and device tools are available via the AsmltrDevice bridge.
const NATIVE = /(?:^|[?&#])native(?:=1)?(?:$|[&#])/.test(location.search + location.hash);
function nativeOverlay() { return NATIVE && window.AsmltrOverlay ? window.AsmltrOverlay : null; }

const ICON = {
  mic: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V22h2v-3.08A7 7 0 0 0 19 12h-2z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="3"/></svg>',
  vol: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13 3a3.5 3.5 0 0 0-2-3.15v6.3A3.5 3.5 0 0 0 16 12zm-2-7.3v2.06a5.5 5.5 0 0 1 0 10.48v2.06A7.5 7.5 0 0 0 14 4.7z"/></svg>',
  muted: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm18.3-1.3l-1.4-1.4L17 9.17 14.83 7 13.4 8.4 15.6 10.6 13.4 12.8l1.4 1.4L17 12l2.9 2.9 1.4-1.4L18.4 10.6z"/></svg>',
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
  // In the native app, adopt the native device id so the web chat stream + the persistent control link
  // share one identity (same conversation_key).
  if (nc.deviceId) c.deviceId = nc.deviceId;
  if (!c.deviceId) c.deviceId = 'dev-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  return c;
}
function saveCfg(c) { localStorage.setItem(CFG_KEY, JSON.stringify(c)); }

let cfg = loadCfg();
let muted = false; try { muted = localStorage.getItem('asmltr.muted') === '1'; } catch (_) {}
let es = null, reconnectT = null;
let state = 'idle';              // 'idle' | 'rec' | 'busy'   (busy covers thinking + reading aloud)
let recorder = null, chunks = [], stream = null, heardSpeech = false;
let curBubble = null, stepsEl = null, lastTool = null, convKey = '';
let drone = null, curAudio = null, vadRAF = 0, vadCtx = null;
let continuous = OVERLAY, suppressRestart = false;
// streaming TTS pipeline (synthesize each sentence as it arrives, play in order)
let ttsBuf = '', ttsSeq = 0, ttsNextPlay = 0, ttsPlaying = false, replyTextDone = false; const ttsClips = {};

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
function addThinking(text) { const s = ensureSteps(); const d = document.createElement('div'); d.className = 'step step-think'; d.textContent = '… ' + text; s.appendChild(d); $('log').scrollTop = $('log').scrollHeight; }
function fmt(v) { try { return typeof v === 'string' ? v : JSON.stringify(v, null, 2); } catch (_) { return String(v); } }
function addTool(name, input) {
  const s = ensureSteps();
  const wrap = document.createElement('div'); wrap.className = 'step step-tool tool-chip';
  const head = document.createElement('div'); head.className = 'tool-head'; head.innerHTML = '<span class="tool-caret">▸</span> ⚙ ' + name;
  const detail = document.createElement('pre'); detail.className = 'tool-detail hidden';
  if (input != null) detail.textContent = 'input:\n' + fmt(input);
  head.addEventListener('click', () => { detail.classList.toggle('hidden'); head.querySelector('.tool-caret').textContent = detail.classList.contains('hidden') ? '▸' : '▾'; });
  wrap.appendChild(head); wrap.appendChild(detail); s.appendChild(wrap);
  lastTool = { wrap, detail }; $('log').scrollTop = $('log').scrollHeight;
}
function addToolResult(output, isErr) {
  if (!lastTool) return;
  lastTool.detail.textContent += (lastTool.detail.textContent ? '\n\n' : '') + 'output:\n' + (output || '');
  if (isErr) lastTool.wrap.classList.add('tool-err');
  lastTool = null;
}
function setState(s) {
  state = s;
  const t = $('talk'), icon = $('talkIcon'), l = $('talkLabel');
  if (!t) return;
  t.className = 'talk' + (s === 'rec' ? ' rec' : s === 'busy' ? ' busy' : '');
  if (icon) icon.innerHTML = s === 'busy' ? ICON.stop : ICON.mic;
  if (l) l.textContent = s === 'rec' ? 'Listening…' : s === 'busy' ? 'Stop' : 'Tap to talk';
}
function setMuted(on) { muted = on; try { localStorage.setItem('asmltr.muted', on ? '1' : '0'); } catch (_) {} const b = $('mute'); if (b) { b.innerHTML = on ? ICON.muted : ICON.vol; b.classList.toggle('on', on); } if (on) stopAudio(); }

// ---------- SSE ----------
function connect() {
  if (!cfg.baseUrl || !cfg.token) { openSheet('Paste your device token to connect.'); return; }
  if (es) { es.close(); es = null; }
  setStatus('connecting…', 'pill-warn');
  const url = `${cfg.baseUrl}/gw/stream?token=${encodeURIComponent(cfg.token)}&device=${encodeURIComponent(cfg.deviceId)}&name=${encodeURIComponent(cfg.name)}`;
  es = new EventSource(url);
  es.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.type === 'ready') { setStatus('connected', 'pill-on'); if (m.conversation_key) convKey = m.conversation_key; maybeAssistLaunch(); }
    else if (m.type === 'thinking') addThinking(m.text);
    else if (m.type === 'tool') addTool(m.name, m.input);
    else if (m.type === 'tool_result') addToolResult(m.output, m.is_error);
    else if (m.type === 'delta') { stopDrone(); if (!curBubble) curBubble = bubble('assistant', ''); curBubble.textContent += m.text; feedTTS(m.text); $('log').scrollTop = $('log').scrollHeight; }
    else if (m.type === 'done') { stopDrone(); curBubble = null; stepsEl = null; flushTTS(); }
    else if (m.type === 'inject') { stepsEl = null; bubble('assistant', m.text); if (m.text && m.text.trim() && !muted) { resetTTS(); feedTTS(m.text); flushTTS(); } }
    else if (m.type === 'device_rpc') runDeviceRPC(m);   // #77: the assistant wants to act on this phone
    else if (m.type === 'error') { stopDrone(); bubble('sys', '⚠ ' + m.error); resetTTS(); setState('idle'); }
  };
  es.onerror = () => { setStatus('reconnecting…', 'pill-warn'); if (es) { es.close(); es = null; } clearTimeout(reconnectT); reconnectT = setTimeout(connect, 2500); };
}
function minimized() { return document.body.classList.contains('minimized'); }
function afterReply() { if (continuous && !suppressRestart && !minimized() && state === 'idle') setTimeout(() => { if (continuous && !suppressRestart && !minimized() && state === 'idle') startRec(); }, 350); }

// ---------- streaming TTS ----------
function feedTTS(text) {
  if (muted) return;
  ttsBuf += text;
  const idx = Math.max(ttsBuf.lastIndexOf('.'), ttsBuf.lastIndexOf('!'), ttsBuf.lastIndexOf('?'), ttsBuf.lastIndexOf('\n'), ttsBuf.lastIndexOf('…'));
  if (idx >= 0) { const chunk = ttsBuf.slice(0, idx + 1).trim(); ttsBuf = ttsBuf.slice(idx + 1); if (chunk) synthSentence(chunk); }
}
function flushTTS() {
  if (muted) { replyTextDone = true; finishReadout(); return; }
  const rest = ttsBuf.trim(); ttsBuf = ''; replyTextDone = true;
  if (rest) synthSentence(rest); else drainTTS();
}
async function synthSentence(text) {
  const seq = ttsSeq++;
  try { const { b64, mime } = await api('/gw/tts', { text }); ttsClips[seq] = suppressRestart ? null : 'data:' + (mime || 'audio/mpeg') + ';base64,' + b64; }
  catch (_) { ttsClips[seq] = null; }
  drainTTS();
}
function drainTTS() {
  if (ttsPlaying) return;
  if (ttsNextPlay in ttsClips) {
    const src = ttsClips[ttsNextPlay]; delete ttsClips[ttsNextPlay]; ttsNextPlay++;
    if (!src) return drainTTS();
    ttsPlaying = true; const a = new Audio(src); curAudio = a;
    a.onended = a.onerror = () => { ttsPlaying = false; if (curAudio === a) curAudio = null; drainTTS(); };
    a.play().catch(() => { ttsPlaying = false; drainTTS(); });
    return;
  }
  if (replyTextDone && ttsNextPlay >= ttsSeq) finishReadout();  // all sentences synthesized + played
}
function finishReadout() { resetTTS(); setState('idle'); afterReply(); }
function resetTTS() { ttsBuf = ''; ttsSeq = 0; ttsNextPlay = 0; ttsPlaying = false; replyTextDone = false; for (const k in ttsClips) delete ttsClips[k]; }

// ---------- turn ----------
async function api(path, body) {
  const r = await fetch(cfg.baseUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: cfg.token, device: cfg.deviceId, name: cfg.name, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
async function sendTurn(text) {
  if (state === 'busy') return;
  suppressRestart = false; resetTTS(); lastTool = null;
  bubble('user', text); setState('busy');
  if (!muted) { chime(); startDrone(); }
  try { await api('/gw/turn', { text }); }
  catch (e) { stopDrone(); bubble('sys', '⚠ ' + e.message); setState('idle'); }
}

// ---------- STOP ----------
function stopEverything() {
  suppressRestart = true; stopDrone(); stopAudio(); resetTTS();
  try { api('/gw/abort', {}).catch(() => {}); } catch (_) {}
  curBubble = null; stepsEl = null; lastTool = null; setState('idle');
}

// ---------- audio ----------
function stopAudio() { try { if (curAudio) { curAudio.pause(); curAudio = null; } } catch (_) {} }
function chime() { try { const a = new Audio('assets/chime.ogg'); a.volume = 0.8; a.play().catch(() => {}); } catch (_) {} }
function startDrone() { try { if (!drone) { drone = new Audio('assets/drone.ogg'); drone.loop = true; drone.volume = 0.45; } drone.currentTime = 0; drone.play().catch(() => {}); } catch (_) {} }
function stopDrone() { try { if (drone) drone.pause(); } catch (_) {} }

// ---------- record + VAD ----------
async function startRec() {
  if (state !== 'idle') return;
  try {
    // IMPORTANT: echoCancellation/noiseSuppression route Chromium through its WebRTC *communication*
    // audio path, which flips Android into MODE_IN_COMMUNICATION and forces Bluetooth headsets onto the
    // HFP "call" profile — hijacking the earbud button to call-mute. Plain (unprocessed) capture keeps the
    // headset on A2DP/media so its gesture still triggers the assistant. We only record when TTS isn't
    // playing, so AEC isn't needed anyway.
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
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
  if (!heardSpeech) { setState('idle'); return; }   // tapped off without speaking → nothing
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
      else if (dt > 7000) { stopRec(); return; }
      vadRAF = requestAnimationFrame(tick);
    };
    vadRAF = requestAnimationFrame(tick);
  } catch (_) {}
}
function stopVAD() { if (vadRAF) cancelAnimationFrame(vadRAF); vadRAF = 0; try { if (vadCtx) { vadCtx.close(); vadCtx = null; } } catch (_) {} }
function blobB64(blob) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); }); }

// ---------- #77 device control ----------
// The assistant emits a device_rpc frame; we run it against this phone via the native AsmltrDevice
// bridge and post the outcome back so the connector can resolve the tool with a real result.
async function runDeviceRPC(m) {
  const id = m.id, tool = m.tool, args = m.args || {};
  let result;
  try {
    if (window.AsmltrDevice && window.AsmltrDevice.dispatch) {
      const raw = window.AsmltrDevice.dispatch(tool, JSON.stringify(args));
      result = JSON.parse(raw || '{"ok":false,"error":"no result"}');
    } else {
      result = { ok: false, error: 'device tools only available in the native app' };
    }
  } catch (e) { result = { ok: false, error: String(e && e.message || e) }; }
  addTool('device:' + tool, args); addToolResult(JSON.stringify(result), !result.ok);
  try { await api('/gw/rpc-result', { id, result }); } catch (_) {}
}

// ---------- assist launch + native overlay controls ----------
function maybeAssistLaunch() { const a = OVERLAY || location.hash.indexOf('assist') >= 0 || window.__ASMLTR_ASSIST === true; if (a && state === 'idle') { window.__ASMLTR_ASSIST = false; setTimeout(() => { if (state === 'idle') startRec(); }, 250); } }
window.asmltrStartListening = () => { if (state === 'idle') startRec(); };
// Called by OverlayService when the card should collapse/expand; also usable from the min button.
window.asmltrMinimize = () => { document.body.classList.add('minimized'); if (state === 'rec') stopRec(); const n = nativeOverlay(); if (n && n.setMinimized) try { n.setMinimized(true); } catch (_) {} };
window.asmltrExpand = () => { document.body.classList.remove('minimized'); const n = nativeOverlay(); if (n && n.setMinimized) try { n.setMinimized(false); } catch (_) {} reportPanelHeight(); };
// Tell the native panel window how tall to be so it hugs the card (open sheet → grow to fit the sheet).
function reportPanelHeight() {
  const ov = nativeOverlay(); if (!ov || !ov.setPanelHeight || document.body.classList.contains('minimized')) return;
  const dpr = window.devicePixelRatio || 1;
  const sheetOpen = $('sheet') && !$('sheet').classList.contains('hidden');
  const scrH = (window.screen && window.screen.height) || window.innerHeight || 640;
  const h = sheetOpen ? Math.round(scrH * 0.85) : Math.ceil($('card').getBoundingClientRect().height);
  if (h > 0) { try { ov.setPanelHeight(Math.round(h * dpr)); } catch (_) {} }
}

// ---------- overlay chrome ----------
function initOverlayChrome() {
  const card = $('card'), handle = $('grip'); if (!card || !handle) return;
  const dpr = window.devicePixelRatio || 1;
  let sx = 0, sy = 0, ox = 0, oy = 0, lx = 0, ly = 0, dragging = false; const pos = { x: 0, y: 0 };
  // Native drag uses SCREEN coords (screenX/Y) — window-relative clientX shifts as the window moves under
  // the finger, which caused the jitter/feedback loop.
  const down = (e) => { if (e.target.closest('button')) return; dragging = true; const p = e.touches ? e.touches[0] : e; sx = p.clientX; sy = p.clientY; lx = p.screenX; ly = p.screenY; ox = pos.x; oy = pos.y; };
  const move = (e) => {
    if (!dragging) return; const p = e.touches ? e.touches[0] : e; const nat = nativeOverlay();
    if (nat && nat.dragBy) {
      const dx = p.screenX - lx, dy = p.screenY - ly; lx = p.screenX; ly = p.screenY;
      if (dx || dy) { try { nat.dragBy(Math.round(dx * dpr), Math.round(dy * dpr)); } catch (_) {} }
    } else { pos.x = ox + (p.clientX - sx); pos.y = oy + (p.clientY - sy); card.style.transform = `translate(calc(-50% + ${pos.x}px), ${pos.y}px)`; }
    e.preventDefault();
  };
  const up = () => { dragging = false; };
  handle.addEventListener('mousedown', down); handle.addEventListener('touchstart', down, { passive: true });
  window.addEventListener('mousemove', move); window.addEventListener('touchmove', move, { passive: false });
  window.addEventListener('mouseup', up); window.addEventListener('touchend', up);
  $('min').addEventListener('click', () => { window.asmltrMinimize(); });
  $('minbubble').addEventListener('click', () => { window.asmltrExpand(); if (continuous && state === 'idle') startRec(); });
  // Native panel: cap the log by screen height (px — not window, to avoid circular sizing) and keep the
  // native window height synced to the card via a ResizeObserver.
  if (nativeOverlay()) {
    const logEl = $('log'); if (logEl) logEl.style.maxHeight = Math.round(((window.screen && window.screen.height) || 640) * 0.42) + 'px';
    try { const ro = new ResizeObserver(() => reportPanelHeight()); ro.observe(card); } catch (_) {}
    setTimeout(reportPanelHeight, 150);
  }
  $('close').addEventListener('click', () => { stopEverything(); try { if (window.AsmltrOverlay && window.AsmltrOverlay.close) window.AsmltrOverlay.close(); } catch (_) {} });
}

// ---------- settings ----------
function openSheet(msg) { $('cfgUrl').value = cfg.baseUrl; $('cfgToken').value = cfg.token; $('cfgName').value = cfg.name; $('cfgDevice').value = cfg.deviceId; $('cfgMsg').textContent = msg || ''; if ($('cfgSession')) $('cfgSession').value = convKey || '(not connected yet)'; if ($('sessMsg')) $('sessMsg').textContent = ''; $('sheet').classList.remove('hidden'); reportPanelHeight(); }
function closeSheet() { $('sheet').classList.add('hidden'); reportPanelHeight(); }
// Start a fresh conversation: stop anything running, ask the connector to forget the core session, wipe the log.
async function newSession() {
  const m = $('sessMsg'); if (m) m.textContent = 'clearing…';
  stopEverything();
  try { const r = await api('/gw/forget', {}); if (m) m.textContent = r && r.existed ? '✓ context cleared — fresh session' : '✓ fresh session'; }
  catch (e) { if (m) m.textContent = '✗ ' + e.message; return; }
  $('log').innerHTML = ''; curBubble = null; stepsEl = null; lastTool = null; resetTTS();
  bubble('sys', 'New session started.');
}
async function testConn() { const base = $('cfgUrl').value.trim().replace(/\/+$/, ''); $('cfgMsg').textContent = 'testing…'; try { const r = await fetch(base + '/health'); const j = await r.json(); $('cfgMsg').textContent = j.status === 'ok' ? '✓ reachable' : 'unexpected'; } catch (e) { $('cfgMsg').textContent = '✗ ' + e.message; } }

// ---------- wire up ----------
function init() {
  if (OVERLAY) { document.documentElement.style.background = 'transparent'; document.body.classList.add('overlay'); if (NATIVE) document.body.classList.add('native'); initOverlayChrome(); }
  $('agentName').textContent = cfg.agentName || 'assistant';
  $('talkIcon').innerHTML = ICON.mic;
  setMuted(muted);
  $('mute').addEventListener('click', () => setMuted(!muted));
  $('talk').addEventListener('click', () => { if (state === 'rec') stopRec(); else if (state === 'busy') stopEverything(); else startRec(); });
  $('settingsBtn').addEventListener('click', () => openSheet());
  if ($('cfgNewSession')) $('cfgNewSession').addEventListener('click', newSession);
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
