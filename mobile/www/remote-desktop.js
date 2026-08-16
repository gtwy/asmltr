'use strict';
/*
 * asmltr mobile — Remote Desktop VIEWER + CONTROLLER for the custom WebRTC remote-desktop capability
 * (see docs/REMOTE-DESKTOP.md + connectors/types/remote-desktop/index.js — the signaling broker).
 *
 * This is a self-contained surface: discover hosts through the broker, open a session, hold the broker
 * SSE stream, relay SDP/ICE through POST /rd/msg so ICE can hole-punch a DIRECT peer-to-peer media path,
 * render the host's video full-screen, and — when the session carries a control grant — map touch→mouse
 * and an on-screen keyboard→keystrokes over a WebRTC `control` data channel.
 *
 * Wire protocol (broker is the rendezvous, NEVER the media path):
 *   viewer holds  GET  /rd/stream?token=&role=viewer&client_id=   (SSE: ready / sdp / ice / bye)
 *   viewer POSTs  POST /rd/msg { token, type, ... }               (list / connect / sdp / ice / bye)
 *   viewer GETs   GET  /rd/ice-config?token=                      (STUN urls + optional TURN creds)
 *
 * Signaling roles: the broker asks the HOST to make the offer (offer_request). So the VIEWER is the
 * ANSWERER — it waits for the host's SDP offer on the SSE stream, answers, and both trickle ICE.
 *
 * The `control` data channel is PRE-NEGOTIATED (negotiated:true, id:0, label 'control') so it doesn't
 * depend on offer ordering or an ondatachannel race — the host agent MUST open the same channel. It only
 * opens client-side when the broker stamped the session with control (view-only otherwise).
 *
 * Lifecycle discipline is lifted from the live-STT fix in app.js: every session carries a GENERATION
 * token (rdGen). Teardown bumps it; every awaited async step re-checks its gen and bails (closing its
 * half-built peer) if superseded — so a session can never leak a PeerConnection or SSE stream.
 */
const RD_CFG_KEY = 'asmltr.rd.cfg';
const MAIN_CFG_KEY = 'asmltr.mobile.cfg';
const $ = (id) => document.getElementById(id);

// ---------- config (device-local, persisted like the assistant's settings) ----------
function loadMainCfg() { try { return JSON.parse(localStorage.getItem(MAIN_CFG_KEY)) || {}; } catch (_) { return {}; } }
function loadCfg() {
  let c = {};
  try { c = JSON.parse(localStorage.getItem(RD_CFG_KEY)) || {}; } catch (_) {}
  const main = loadMainCfg();
  const d = window.ASMLTR_DEFAULTS || {};
  // Broker is a SEPARATE service (the remote-desktop connector, default :3028 /rd/*), so it has its own
  // URL. Token defaults to the device token (same keys.json trust identity convention), overridable.
  c.brokerUrl = (c.brokerUrl || d.rdBrokerUrl || '').replace(/\/+$/, '');
  c.token = c.token || main.token || d.token || '';
  if (!c.clientId) c.clientId = 'rdc-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  return c;
}
function saveCfg(c) { try { localStorage.setItem(RD_CFG_KEY, JSON.stringify(c)); } catch (_) {} }
let cfg = loadCfg();

// ---------- broker HTTP ----------
async function rdMsg(body) {
  if (!cfg.brokerUrl) throw new Error('set the broker URL in settings');
  const r = await fetch(cfg.brokerUrl + '/rd/msg', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: cfg.token, ...body }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
async function fetchIce() {
  try {
    const r = await fetch(cfg.brokerUrl + '/rd/ice-config?token=' + encodeURIComponent(cfg.token));
    const j = await r.json().catch(() => ({}));
    if (j && j.iceServers) return j.iceServers;
  } catch (_) {}
  return [{ urls: ['stun:stun.l.google.com:19302'] }]; // safe fallback so ICE still has a STUN server
}

// ---------- status / view switching ----------
function setStatus(text, cls) { const el = $('rdStatus'); if (el) { el.textContent = text; el.className = 'pill pill-' + (cls || 'off'); } }
function showList() { $('rdStage').classList.add('hidden'); $('rdList').classList.remove('hidden'); }
function showStage() { $('rdList').classList.add('hidden'); $('rdStage').classList.remove('hidden'); }

// ---------- session state + generation guard ----------
let sess = null;          // { id, control, pc, es, host } for the live session, else null
let rdGen = 0;            // bumped on every teardown/switch; stale async steps self-abort (see live-STT fix)
let pendingIce = [];      // remote ICE that arrived before setRemoteDescription
let readyResolve = null;  // resolves when the viewer SSE stream sends its first `ready`

// ---------- host discovery ----------
async function refreshHosts() {
  const listEl = $('rdHosts'); const msg = $('rdListMsg');
  if (!cfg.brokerUrl || !cfg.token) { openSettings('Set the broker URL and token to discover hosts.'); return; }
  if (msg) msg.textContent = 'discovering…';
  try {
    const r = await rdMsg({ type: 'list' });
    const hosts = r.hosts || [];
    listEl.innerHTML = '';
    if (!hosts.length) { if (msg) msg.textContent = 'No hosts online. Start a host agent, then refresh.'; return; }
    if (msg) msg.textContent = hosts.length + ' host' + (hosts.length === 1 ? '' : 's') + ' online';
    for (const h of hosts) listEl.appendChild(hostRow(h));
  } catch (e) { if (msg) msg.textContent = '✗ ' + e.message; }
}
function hostRow(h) {
  const row = document.createElement('div'); row.className = 'rd-host';
  const info = document.createElement('div'); info.className = 'rd-host-info';
  const nm = document.createElement('div'); nm.className = 'rd-host-name'; nm.textContent = h.name || h.host_id;
  const caps = document.createElement('div'); caps.className = 'rd-host-caps';
  const bits = ['video']; if (h.caps && h.caps.audio) bits.push('audio'); if (h.caps && h.caps.control) bits.push('control');
  caps.textContent = bits.join(' · '); info.appendChild(nm); info.appendChild(caps);
  const btns = document.createElement('div'); btns.className = 'rd-host-btns';
  const view = document.createElement('button'); view.className = 'secondary rd-btn'; view.textContent = 'View';
  view.addEventListener('click', () => connectHost(h, false));
  btns.appendChild(view);
  if (h.caps && h.caps.control) {
    const ctl = document.createElement('button'); ctl.className = 'primary rd-btn'; ctl.textContent = 'Control';
    ctl.addEventListener('click', () => connectHost(h, true));
    btns.appendChild(ctl);
  }
  row.appendChild(info); row.appendChild(btns);
  return row;
}

// ---------- SSE signaling stream ----------
function openStream(gen) {
  const url = cfg.brokerUrl + '/rd/stream?token=' + encodeURIComponent(cfg.token)
    + '&role=viewer&client_id=' + encodeURIComponent(cfg.clientId);
  const es = new EventSource(url);
  es.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (_) { return; } onSignal(m, gen); };
  es.onerror = () => { if (gen === rdGen && sess) setStatus('signaling dropped — reconnecting…', 'warn'); };
  return es;
}
function waitReady(gen) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { readyResolve = null; reject(new Error('broker stream timeout')); }, 10000);
    readyResolve = () => { clearTimeout(to); readyResolve = null; resolve(); };
    void gen;
  });
}
async function onSignal(m, gen) {
  if (gen !== rdGen) return;                       // frame from a torn-down session
  const t = String(m.type || '');
  if (t === 'ready') { if (readyResolve) readyResolve(); return; }
  if (!sess || m.session_id !== sess.id) return;   // only our current session's peer traffic
  if (t === 'sdp') return onRemoteSdp(m.sdp, gen);
  if (t === 'ice') return onRemoteIce(m.candidate, gen);
  if (t === 'bye') { setStatus('host ended the session', 'off'); return teardown(); }
}

// ---------- SDP / ICE relay (viewer = answerer) ----------
async function onRemoteSdp(desc, gen) {
  if (!sess || !desc) return;
  try {
    // Accept either a full RTCSessionDescription {type,sdp} or a bare sdp string (default it to 'offer').
    const offer = (desc && desc.type && desc.sdp) ? desc : { type: 'offer', sdp: desc };
    await sess.pc.setRemoteDescription(offer);
    if (gen !== rdGen) return;
    for (const c of pendingIce) { try { await sess.pc.addIceCandidate(c); } catch (_) {} }
    pendingIce = [];
    const answer = await sess.pc.createAnswer();
    if (gen !== rdGen) return;
    await sess.pc.setLocalDescription(answer);
    if (gen !== rdGen) return;
    // role is REQUIRED: host + phone share the "owner" trust identity, so the broker can't infer the
    // relay direction from the token — we must tell it we're the viewer.
    await rdMsg({ type: 'sdp', session_id: sess.id, role: 'viewer', sdp: { type: answer.type, sdp: answer.sdp } });
  } catch (e) { if (gen === rdGen) setStatus('sdp error: ' + e.message, 'warn'); }
}
async function onRemoteIce(cand, gen) {
  if (!sess || !cand) return;
  // Buffer candidates that beat the remote description in (WebRTC rejects them otherwise).
  if (!sess.pc.remoteDescription || !sess.pc.remoteDescription.type) { pendingIce.push(cand); return; }
  try { await sess.pc.addIceCandidate(cand); } catch (_) { if (gen !== rdGen) return; }
}

// ---------- connect / peer wiring ----------
async function connectHost(host, wantControl) {
  teardown();                        // drop anything live (bumps rdGen, closes prior peer + stream)
  const gen = ++rdGen;
  pendingIce = [];
  showStage();
  $('rdStageName').textContent = host.name || host.host_id;
  setControlUI(false);
  setStatus('connecting…', 'warn');
  try {
    const es = openStream(gen);
    await waitReady(gen);
    if (gen !== rdGen) { try { es.close(); } catch (_) {} return; }
    const iceServers = await fetchIce();
    if (gen !== rdGen) { try { es.close(); } catch (_) {} return; }
    const r = await rdMsg({ type: 'connect', host_id: host.host_id, want: { control: !!wantControl }, client_id: cfg.clientId });
    if (gen !== rdGen) { try { es.close(); } catch (_) {} return; }
    const control = !!r.control;
    const pc = new RTCPeerConnection({ iceServers });
    sess = { id: r.session_id, control, pc, es, host };
    wirePeer(pc, r.session_id, gen, control);
    if (wantControl && !control) setStatus('connected (view-only — no control grant)', 'on');
    // The host now receives offer_request and sends its SDP offer over our SSE stream → onRemoteSdp().
  } catch (e) {
    if (gen === rdGen) { setStatus('✗ ' + e.message, 'off'); teardown(); }
  }
}
function wirePeer(pc, sessionId, gen, control) {
  pc.onicecandidate = (e) => {
    if (e.candidate && gen === rdGen) {
      rdMsg({ type: 'ice', session_id: sessionId, role: 'viewer', candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate }).catch(() => {});
    }
  };
  pc.ontrack = (e) => {
    if (gen !== rdGen) return;
    const v = $('rdVideo');
    if (v && e.streams && e.streams[0]) { v.srcObject = e.streams[0]; v.play().catch(() => {}); }
  };
  pc.onconnectionstatechange = () => {
    if (gen !== rdGen) return;
    const s = pc.connectionState;
    if (s === 'connected') setStatus(sess && sess.control ? 'connected · control' : 'connected · view-only', 'on');
    else if (s === 'connecting') setStatus('negotiating…', 'warn');
    else if (s === 'disconnected') setStatus('link dropped — recovering…', 'warn');
    else if (s === 'failed') { setStatus('connection failed', 'off'); teardown(); }
  };
  if (control) {
    // Pre-negotiated so it survives offer/answer ordering and needs no renegotiation. The host agent
    // MUST open the identical channel: label 'control', negotiated:true, id:0.
    const dc = pc.createDataChannel('control', { negotiated: true, id: 0, ordered: true });
    dc.onopen = () => { if (gen === rdGen && sess) { sess.control = true; setControlUI(true); } };
    dc.onclose = () => { if (gen === rdGen) setControlUI(false); };
    sess.dc = dc;
  }
}

// ---------- teardown (leak-proof) ----------
function teardown() {
  rdGen++;                        // invalidate every in-flight async step for the dying session
  readyResolve = null; pendingIce = [];
  const s = sess; sess = null;
  cancelMoveFlush();
  if (s) {
    try { if (s.dc) s.dc.close(); } catch (_) {}
    try { if (s.pc) s.pc.close(); } catch (_) {}
    try { if (s.es) s.es.close(); } catch (_) {}
    try { rdMsg({ type: 'bye', session_id: s.id }).catch(() => {}); } catch (_) {}   // tell broker + host
  }
  const v = $('rdVideo'); if (v) { try { v.srcObject = null; } catch (_) {} }
  setControlUI(false);
  exitMinimize();
  hideKeyboard();
}
function disconnect() { setStatus('disconnected', 'off'); teardown(); showList(); refreshHosts(); }

// ==================== CONTROL LAYER (touch→mouse + soft keyboard) ====================
// Sent as JSON over the `control` data channel. Coordinates are normalized [0,1] fractions of the remote
// screen (absolute-scaled to the displayed video's content rect, letterboxing accounted for) so the host
// maps them to any resolution. Schema the host agent MUST match:
//   mouse: { t:'move'|'down'|'up'|'click'|'scroll', x, y, button, dx, dy }
//           - move/down/up/click carry x,y in [0,1]; button ∈ 'left'|'right'|'middle' (default 'left')
//           - scroll carries dx,dy wheel deltas (pixels; sign = direction), x,y optional
//   key:   { t:'key', code, down }  down=true (press) / false (release)
//           - code is a UI-Events code ('KeyA','Enter','Backspace','Space','Digit1',…) when known,
//             else the literal character; an optional `key` field carries the raw character.
function sendCtl(obj) {
  const dc = sess && sess.dc;
  if (dc && dc.readyState === 'open') { try { dc.send(JSON.stringify(obj)); } catch (_) {} }
}
function haptic(ms) { try { if (navigator.vibrate) navigator.vibrate(ms || 8); } catch (_) {} }

function setControlUI(on) {
  const ctl = $('rdControl'); const kb = $('rdKbBtn');
  if (ctl) ctl.classList.toggle('active', !!on);          // control overlay only captures when granted
  if (kb) kb.classList.toggle('hidden', !on);
  const badge = $('rdCtlBadge'); if (badge) badge.classList.toggle('hidden', !on);
}

// Map a client point to normalized video-content coords (handles object-fit: contain letterboxing).
function mapXY(clientX, clientY) {
  const v = $('rdVideo'); const r = v.getBoundingClientRect();
  const vw = v.videoWidth || r.width, vh = v.videoHeight || r.height;
  const scale = Math.min(r.width / vw, r.height / vh);
  const w = vw * scale, h = vh * scale;
  const ox = r.left + (r.width - w) / 2, oy = r.top + (r.height - h) / 2;
  let x = (clientX - ox) / w, y = (clientY - oy) / h;
  x = Math.max(0, Math.min(1, x)); y = Math.max(0, Math.min(1, y));
  return { x, y };
}

// Gesture recognition on the transparent control overlay via pointer events (touch now; mouse/D-pad later
// for a TV). One finger: quick tap = left click, drag = cursor move, long-press = right click. Two fingers:
// drag = scroll wheel, quick tap = right click.
const MOVE_THRESH = 8, TAP_MS = 350, LONGPRESS_MS = 550;
let ptrs = new Map();       // pointerId → { x, y, sx, sy, st }
let moved = false, lpTimer = 0, lpFired = false, twoFinger = false, scrolled = false, lastCentroid = null;
let pendingMove = null, moveRAF = 0;

function centroid() { let x = 0, y = 0, n = 0; for (const p of ptrs.values()) { x += p.x; y += p.y; n++; } return n ? { x: x / n, y: y / n } : null; }
function queueMove(m) {
  pendingMove = m;
  if (!moveRAF) moveRAF = requestAnimationFrame(() => { moveRAF = 0; if (pendingMove) { sendCtl({ t: 'move', x: pendingMove.x, y: pendingMove.y }); pendingMove = null; } });
}
function cancelMoveFlush() { if (moveRAF) { cancelAnimationFrame(moveRAF); moveRAF = 0; } pendingMove = null; ptrs.clear(); clearTimeout(lpTimer); moved = false; lpFired = false; twoFinger = false; scrolled = false; lastCentroid = null; }

function initControlGestures() {
  const el = $('rdControl'); if (!el) return;
  el.addEventListener('pointerdown', (e) => {
    if (!(sess && sess.control)) return;
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, st: Date.now() });
    if (ptrs.size === 1) {
      moved = false; lpFired = false; twoFinger = false; scrolled = false;
      clearTimeout(lpTimer);
      lpTimer = setTimeout(() => {
        if (ptrs.size === 1 && !moved) { lpFired = true; const p = [...ptrs.values()][0]; const m = mapXY(p.x, p.y); sendCtl({ t: 'click', button: 'right', x: m.x, y: m.y }); haptic(14); }
      }, LONGPRESS_MS);
    } else if (ptrs.size === 2) { clearTimeout(lpTimer); twoFinger = true; lastCentroid = centroid(); }
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    const p = ptrs.get(e.pointerId); if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    if (ptrs.size >= 2) {
      const c = centroid();
      if (c && lastCentroid) { const dx = c.x - lastCentroid.x, dy = c.y - lastCentroid.y; if (Math.abs(dx) > 1 || Math.abs(dy) > 1) { scrolled = true; sendCtl({ t: 'scroll', dx: Math.round(dx), dy: Math.round(dy) }); } }
      lastCentroid = c;
    } else {
      if (!moved && Math.hypot(p.x - p.sx, p.y - p.sy) > MOVE_THRESH) { moved = true; clearTimeout(lpTimer); }
      if (moved) queueMove(mapXY(p.x, p.y));
    }
    e.preventDefault();
  });
  const onUp = (e) => {
    const p = ptrs.get(e.pointerId); ptrs.delete(e.pointerId);
    clearTimeout(lpTimer);
    if (p) {
      const dt = Date.now() - p.st, dist = Math.hypot(p.x - p.sx, p.y - p.sy);
      if (twoFinger) {
        if (ptrs.size === 0 && dt < TAP_MS && dist < MOVE_THRESH && !scrolled) { const m = mapXY(p.x, p.y); sendCtl({ t: 'click', button: 'right', x: m.x, y: m.y }); haptic(); }
      } else if (!lpFired && !moved && dt < TAP_MS && dist < MOVE_THRESH) {
        const m = mapXY(p.x, p.y); sendCtl({ t: 'click', button: 'left', x: m.x, y: m.y }); haptic();
      }
    }
    if (ptrs.size === 0) { moved = false; lpFired = false; twoFinger = false; scrolled = false; lastCentroid = null; }
    e.preventDefault();
  };
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
}

// ---------- on-screen keyboard ----------
// A hidden input pulls up the soft keyboard. Hardware/special keys ride keydown/keyup; typed characters
// come through `input` (soft keyboards report KeyCode 229 with an empty code, so we can't rely on
// keydown for letters) and are sent as a press+release pair each.
const SPECIAL_KEYS = ['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];
function charToCode(ch) {
  if (/[a-z]/i.test(ch)) return 'Key' + ch.toUpperCase();
  if (/[0-9]/.test(ch)) return 'Digit' + ch;
  if (ch === ' ') return 'Space';
  return ch; // punctuation / symbols → the literal character (host uses `key` for the exact glyph)
}
function showKeyboard() { const i = $('rdKbInput'); if (i) { i.classList.remove('hidden'); i.value = ''; try { i.focus(); } catch (_) {} } const b = $('rdKbBtn'); if (b) b.classList.add('on'); }
function hideKeyboard() { const i = $('rdKbInput'); if (i) { try { i.blur(); } catch (_) {} i.classList.add('hidden'); i.value = ''; } const b = $('rdKbBtn'); if (b) b.classList.remove('on'); }
function toggleKeyboard() { const i = $('rdKbInput'); if (i && i.classList.contains('hidden')) showKeyboard(); else hideKeyboard(); }
function initKeyboard() {
  const i = $('rdKbInput'); if (!i) return;
  i.addEventListener('keydown', (e) => {
    if (SPECIAL_KEYS.includes(e.key)) {
      sendCtl({ t: 'key', code: e.code || e.key, key: e.key, down: true });
      sendCtl({ t: 'key', code: e.code || e.key, key: e.key, down: false });
      e.preventDefault();
    }
  });
  i.addEventListener('input', (e) => {
    const data = e.data;
    if (data) { for (const ch of data) { const code = charToCode(ch); sendCtl({ t: 'key', code, key: ch, down: true }); sendCtl({ t: 'key', code, key: ch, down: false }); } }
    i.value = ''; // keep the field empty — we've already emitted the keystrokes
  });
}

// ---------- minimize / picture-in-picture ----------
function toggleMinimize() { const st = $('rdStage'); if (!st) return; if (st.classList.contains('min')) exitMinimize(); else enterMinimize(); }
function enterMinimize() { const st = $('rdStage'); if (st) st.classList.add('min'); }
function exitMinimize() { const st = $('rdStage'); if (st) st.classList.remove('min'); }
async function togglePip() {
  const v = $('rdVideo'); if (!v) return;
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else if (v.requestPictureInPicture) await v.requestPictureInPicture();
  } catch (_) {}
}
function toggleAudio() { const v = $('rdVideo'); if (!v) return; v.muted = !v.muted; const b = $('rdMuteBtn'); if (b) b.classList.toggle('on', v.muted); }

// ---------- settings sheet ----------
function openSettings(msg) {
  $('rdCfgUrl').value = cfg.brokerUrl || '';
  $('rdCfgToken').value = cfg.token || '';
  $('rdCfgClient').value = cfg.clientId || '';
  $('rdCfgMsg').textContent = msg || '';
  $('rdSheet').classList.remove('hidden');
}
function closeSettings() { $('rdSheet').classList.add('hidden'); }
function saveSettings() {
  cfg.brokerUrl = $('rdCfgUrl').value.trim().replace(/\/+$/, '');
  cfg.token = $('rdCfgToken').value.trim();
  saveCfg(cfg);
  closeSettings(); refreshHosts();
}
async function testBroker() {
  const base = $('rdCfgUrl').value.trim().replace(/\/+$/, '');
  $('rdCfgMsg').textContent = 'testing…';
  try { const r = await fetch(base + '/rd/health'); const j = await r.json(); $('rdCfgMsg').textContent = j && j.ok ? ('✓ reachable — ' + (j.hosts || 0) + ' hosts online') : 'unexpected response'; }
  catch (e) { $('rdCfgMsg').textContent = '✗ ' + e.message; }
}

// ---------- cast-to-device auto-open ----------
// Opened via remote-desktop.html?host=<id>&control=<0|1> — a trusted caster pushed an
// open-remote-desktop directive (the dashboard's "Cast to my phone" / the assistant) and app.js
// navigated here. Auto-connect straight to that host instead of waiting for a tap. Falls back to a
// synthetic host entry if the broker's list doesn't (yet) include it, so a just-registered host still opens.
async function maybeAutoOpen() {
  let params; try { params = new URLSearchParams(location.search); } catch (_) { return; }
  const host = params.get('host'); if (!host) return;
  const wantControl = params.get('control') === '1';
  if (!cfg.brokerUrl || !cfg.token) { openSettings('A host was cast to this device — set the broker URL and token to open it.'); return; }
  setStatus('opening cast…', 'warn');
  try {
    const r = await rdMsg({ type: 'list' });
    const found = (r.hosts || []).find((h) => h.host_id === host)
      || { host_id: host, name: host, caps: { video: true, control: wantControl } };
    connectHost(found, wantControl && !!(found.caps && found.caps.control));
  } catch (e) { setStatus('✗ ' + e.message, 'off'); }
}

// ---------- back / leave ----------
function goBack() {
  if (!$('rdStage').classList.contains('hidden')) { disconnect(); return; }  // in a session → drop it, show list
  try { history.length > 1 ? history.back() : (location.href = 'index.html'); } catch (_) { location.href = 'index.html'; }
}

// ---------- wire up ----------
function init() {
  showList();
  setStatus('offline', 'off');
  $('rdRefresh').addEventListener('click', refreshHosts);
  $('rdSettingsBtn').addEventListener('click', () => openSettings());
  $('rdBack').addEventListener('click', goBack);
  $('rdDisconnect').addEventListener('click', disconnect);
  $('rdMinBtn').addEventListener('click', toggleMinimize);
  $('rdPipBtn').addEventListener('click', togglePip);
  $('rdMuteBtn').addEventListener('click', toggleAudio);
  $('rdKbBtn').addEventListener('click', toggleKeyboard);
  $('rdStage').addEventListener('dblclick', () => { if ($('rdStage').classList.contains('min')) exitMinimize(); });
  // tapping a minimized tile restores it (mousedown so it beats the control overlay)
  $('rdStage').addEventListener('click', () => { if ($('rdStage').classList.contains('min')) exitMinimize(); });
  $('rdCfgSave').addEventListener('click', saveSettings);
  $('rdCfgTest').addEventListener('click', testBroker);
  $('rdCfgClose').addEventListener('click', closeSettings);
  $('rdSheet').addEventListener('click', (e) => { if (e.target === $('rdSheet')) closeSettings(); });
  initControlGestures();
  initKeyboard();
  // hardware-back / navigating away must not leak the peer + SSE
  window.addEventListener('pagehide', () => { try { teardown(); } catch (_) {} });
  window.addEventListener('beforeunload', () => { try { teardown(); } catch (_) {} });
  refreshHosts();
  maybeAutoOpen(); // cast-to-device: ?host=<id>&control=<0|1> auto-connects straight to that host
}
document.addEventListener('DOMContentLoaded', init);
