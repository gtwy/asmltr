#!/usr/bin/env node
'use strict';
/**
 * asmltr-device — an MCP stdio server that lets the assistant ACTUATE a connected phone (the android
 * connector's device). Each tool POSTs {tool,args} to the android gateway's /gw/rpc, which pushes a
 * device_rpc frame to the app; the app runs it via the native AsmltrDevice bridge and posts the result
 * back, which the gateway returns here — so the model sees a real result (battery %, launched package…).
 *
 * Targets the most-recently-connected device by default (single-phone installs "just work"); pass
 * `device` to disambiguate. Gateway URL from ASMLTR_ANDROID_GW (default http://127.0.0.1:3027).
 * Zero deps: minimal newline-delimited JSON-RPC 2.0 stdio loop (MCP stdio framing), native fetch.
 */
const readline = require('readline');
const GW = (process.env.ASMLTR_ANDROID_GW || 'http://127.0.0.1:3027').replace(/\/+$/, '');
const NAME = process.env.ASSISTANT_NAME || 'asmltr';

// MCP tool → device_rpc tool name + how to shape args. Kept small, permission-light, engine-agnostic.
const dev = { type: 'string' };
const TOOLS = [
  { name: 'device_battery', tool: 'battery', description: "Read the phone's battery level and charging state.",
    inputSchema: { type: 'object', properties: { device: dev }, additionalProperties: false } },
  { name: 'device_set_volume', tool: 'set_volume', description: 'Set a volume stream to a percentage (0-100).',
    inputSchema: { type: 'object', required: ['percent'], properties: { percent: { type: 'integer', minimum: 0, maximum: 100 }, stream: { type: 'string', enum: ['media', 'ring', 'alarm', 'call', 'notification'], description: 'default media' }, device: dev }, additionalProperties: false } },
  { name: 'device_get_volume', tool: 'get_volume', description: 'Read the current volume percentage of a stream.',
    inputSchema: { type: 'object', properties: { stream: { type: 'string', enum: ['media', 'ring', 'alarm', 'call', 'notification'] }, device: dev }, additionalProperties: false } },
  { name: 'device_set_ringer', tool: 'set_ringer', description: 'Set the ringer mode (normal | vibrate | silent). May require Do-Not-Disturb access.',
    inputSchema: { type: 'object', required: ['mode'], properties: { mode: { type: 'string', enum: ['normal', 'vibrate', 'silent'] }, device: dev }, additionalProperties: false } },
  { name: 'device_torch', tool: 'torch', description: 'Turn the flashlight/torch on or off.',
    inputSchema: { type: 'object', required: ['on'], properties: { on: { type: 'boolean' }, device: dev }, additionalProperties: false } },
  { name: 'device_launch_app', tool: 'launch_app', description: 'Launch an app by name or package (fuzzy-matches installed launchable apps).',
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string', description: 'app name or package, e.g. "spotify"' }, device: dev }, additionalProperties: false } },
  { name: 'device_open_url', tool: 'open_url', description: 'Open a URL (or deep link) on the phone.',
    inputSchema: { type: 'object', required: ['url'], properties: { url: { type: 'string' }, device: dev }, additionalProperties: false } },
  { name: 'device_open_setting', tool: 'open_setting', description: 'Open a system settings screen.',
    inputSchema: { type: 'object', required: ['screen'], properties: { screen: { type: 'string', enum: ['wifi', 'bluetooth', 'display', 'sound', 'battery', 'location', 'apps', 'settings'] }, device: dev }, additionalProperties: false } },
  { name: 'device_list_apps', tool: 'list_apps', description: 'List the launchable apps installed on the phone (label + package).',
    inputSchema: { type: 'object', properties: { device: dev }, additionalProperties: false } },
  // ── on-screen control (needs the accessibility service enabled on the phone) ──
  { name: 'device_read_screen', tool: 'read_screen', description: "Read the on-screen UI as a list of elements (text, class, on-screen bounds + center cx/cy, clickable/editable). Use this to SEE the layout, then tap by coordinates or text.",
    inputSchema: { type: 'object', properties: { max: { type: 'integer', description: 'max elements (default 120)' }, device: dev }, additionalProperties: false } },
  { name: 'device_screenshot', tool: 'screenshot', description: 'Take a screenshot of the phone and return it as an image so you can see the screen.',
    inputSchema: { type: 'object', properties: { max_dim: { type: 'integer', description: 'longest side px (default 1024)' }, quality: { type: 'integer', description: 'JPEG quality 20-90 (default 55)' }, device: dev }, additionalProperties: false } },
  { name: 'device_tap', tool: 'tap', description: 'Tap at screen coordinates (x,y in pixels — get them from device_read_screen bounds/cx,cy).',
    inputSchema: { type: 'object', required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' }, device: dev }, additionalProperties: false } },
  { name: 'device_tap_text', tool: 'tap_text', description: 'Tap the first on-screen element whose text/label contains this string (robust than raw coordinates).',
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, device: dev }, additionalProperties: false } },
  { name: 'device_long_press', tool: 'long_press', description: 'Long-press at screen coordinates (x,y).',
    inputSchema: { type: 'object', required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' }, device: dev }, additionalProperties: false } },
  { name: 'device_swipe', tool: 'swipe', description: 'Swipe/scroll from (x1,y1) to (x2,y2) over ms milliseconds.',
    inputSchema: { type: 'object', required: ['x1', 'y1', 'x2', 'y2'], properties: { x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' }, ms: { type: 'integer', description: 'default 300' }, device: dev }, additionalProperties: false } },
  { name: 'device_type', tool: 'type_text', description: 'Type text into the currently focused (or first) text field.',
    inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, device: dev }, additionalProperties: false } },
  { name: 'device_global', tool: 'global', description: 'Global navigation: back, home, recents, notifications, quick_settings, or lock.',
    inputSchema: { type: 'object', required: ['action'], properties: { action: { type: 'string', enum: ['back', 'home', 'recents', 'notifications', 'quick_settings', 'lock'] }, device: dev }, additionalProperties: false } },
];
const BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

async function rpc(tool, args) {
  const { device, ...rest } = args || {};
  try {
    const r = await fetch(`${GW}/gw/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // screenshots need more headroom than the default RPC timeout
      body: JSON.stringify({ device: device || undefined, tool, args: rest, timeout_ms: tool === 'screenshot' ? 25000 : 20000 }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) return { isError: true, text: (j && j.error) || `gateway ${r.status}` };
    return { isError: !!(j.result && j.result.ok === false), result: j.result };
  } catch (e) { return { isError: true, text: `device gateway unreachable at ${GW}: ${e.message}` }; }
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  if (msg.method === 'notifications/initialized' || msg.id === undefined) return;
  switch (msg.method) {
    case 'initialize':
      return ok(msg.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: `${NAME}-device`, version: '1.0.0' } });
    case 'ping':
      return ok(msg.id, {});
    case 'tools/list':
      return ok(msg.id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const t = BY_NAME[(msg.params || {}).name];
      if (!t) return fail(msg.id, -32602, `unknown tool: ${(msg.params || {}).name}`);
      const r = await rpc(t.tool, msg.params.arguments || {});
      if (r.isError && r.text) return ok(msg.id, { content: [{ type: 'text', text: r.text }], isError: true });
      const res = r.result || {};
      // A screenshot comes back as base64 JPEG → hand the model an actual image block it can see.
      if (t.tool === 'screenshot' && res.ok && res.image) {
        return ok(msg.id, { content: [
          { type: 'image', data: res.image, mimeType: res.mime || 'image/jpeg' },
          { type: 'text', text: `screenshot ${res.w}x${res.h}` },
        ], isError: false });
      }
      return ok(msg.id, { content: [{ type: 'text', text: JSON.stringify(res) }], isError: r.isError });
    }
    default:
      return fail(msg.id, -32601, `method not found: ${msg.method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => { const s = line.trim(); if (!s) return; let msg; try { msg = JSON.parse(s); } catch { return; } Promise.resolve(handle(msg)).catch(() => {}); });
rl.on('close', () => process.exit(0));
