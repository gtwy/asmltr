'use strict';
/**
 * asmltr notify — the proactive read-aloud / delivery primitive (Part A of docs/NOTIFY-READ-ALOUD.md).
 * Any session or schedule can call this to REACH the user; it walks a configurable delivery ladder and
 * uses the best reachable channel:
 *
 *   1. android read-aloud — push a `speak` frame to a connected assistant device (the app TTS-reads it).
 *   2. push               — optional web/native push hook (no-op unless a sender is configured).
 *   3. text fallback      — a configured connector+target (telegram/discord/email) via the manager /send.
 *
 * Everything routes through the connector manager's unified `/send` (same path core replies use), so this
 * stays portable — NO hardcoded host scripts. Config lives at ~/.asmltr/notify.json (override with
 * $ASMLTR_NOTIFY_FILE). Quiet hours suppress the SPOKEN step (text still goes, unless force).
 *
 * NOTE: this is the assistant→user path. The Android *notification reader* (Part B) is separate and native;
 * it must NOT use this ladder's text fallback (a phone notification never bounces to telegram/push).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function file() { return process.env.ASMLTR_NOTIFY_FILE || path.join(os.homedir(), '.asmltr', 'notify.json'); }

const DEFAULTS = {
  ladder: ['android', 'push', 'text'],       // order to try; unknown/unconfigured steps are skipped
  quiet_hours: { start: 23, end: 8 },        // local-clock hours [start, end); suppresses the spoken step
  require_headphones: false,                 // hint sent to the app: only read aloud over a BT route
  android_channel: 'android',                // connector type/channel for the read-aloud step
  android_target: '*',                       // '*' = every connected device; or a specific device id
  text_fallback: null,                       // { channel|instance_id, target } for the text step (null = off)
};

function getConfig() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) }; }
  catch (_) { return { ...DEFAULTS }; }
}
function setConfig(patch) {
  const cfg = { ...getConfig(), ...(patch || {}) };
  const f = file(); fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2));
  return cfg;
}

/** Is `date` inside the quiet-hours window (handles the overnight wrap, e.g. 23→8)? */
function inQuietHours(cfg, date) {
  const q = cfg.quiet_hours; if (!q || q.start == null || q.end == null) return false;
  const h = (date || new Date()).getHours();
  return q.start <= q.end ? (h >= q.start && h < q.end) : (h >= q.start || h < q.end);
}

function mgrBase() { return (process.env.ASMLTR_MANAGER_URL || 'http://127.0.0.1:3024').replace(/\/$/, ''); }
function mgrHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (process.env.ASMLTR_MANAGER_TOKEN) h.Authorization = 'Bearer ' + process.env.ASMLTR_MANAGER_TOKEN;
  return h;
}
async function send(body) {
  const r = await fetch(`${mgrBase()}/send`, { method: 'POST', headers: mgrHeaders(), body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { httpOk: r.ok, ...j };
}

// A push sender can be injected for tests / future web-push wiring. Default: unconfigured no-op.
let _pushSender = null;
function setPushSender(fn) { _pushSender = typeof fn === 'function' ? fn : null; }

/**
 * Deliver `text` to the user via the best reachable step.
 *   opts: { text, title?, force?, speak? }  — force ignores quiet hours; speak=false skips the spoken step.
 * Returns { delivered, via, steps } — steps is the per-attempt log (for telemetry / the GUI test button).
 */
async function notify(opts = {}) {
  const text = String(opts.text || '').trim();
  if (!text) throw new Error('notify needs text');
  const cfg = getConfig();
  const quiet = !opts.force && inQuietHours(cfg);
  const steps = [];

  for (const step of cfg.ladder || []) {
    try {
      if (step === 'android') {
        if (opts.speak === false || quiet) { steps.push({ step, skipped: quiet ? 'quiet-hours' : 'speak-off' }); continue; }
        const r = await send({ channel: cfg.android_channel, target: cfg.android_target, kind: 'speak', text, title: opts.title, require_headphones: !!cfg.require_headphones });
        const ok = !!(r.ok && (r.delivered == null || r.delivered > 0));
        steps.push({ step, ok, delivered: r.delivered, error: r.error });
        if (ok) return { delivered: true, via: 'android', steps };
      } else if (step === 'push') {
        if (!_pushSender) { steps.push({ step, skipped: 'no-push-sender' }); continue; }
        const r = await _pushSender({ text, title: opts.title });
        steps.push({ step, ok: !!(r && r.ok !== false) });
        if (r && r.ok !== false) return { delivered: true, via: 'push', steps };
      } else if (step === 'text') {
        const fb = cfg.text_fallback;
        if (!fb || !(fb.channel || fb.instance_id) || !fb.target) { steps.push({ step, skipped: 'no-fallback-configured' }); continue; }
        const r = await send({ channel: fb.channel, instance_id: fb.instance_id, target: fb.target, kind: 'text', text: opts.title ? `${opts.title}\n${text}` : text });
        steps.push({ step, ok: !!r.ok, error: r.error });
        if (r.ok) return { delivered: true, via: 'text', steps };
      } else {
        steps.push({ step, skipped: 'unknown-step' });
      }
    } catch (e) {
      steps.push({ step, ok: false, error: e.message });
    }
  }
  return { delivered: false, via: null, steps };
}

module.exports = { notify, getConfig, setConfig, inQuietHours, setPushSender, file, DEFAULTS };
