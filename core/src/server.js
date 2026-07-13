#!/usr/bin/env node
'use strict';
require('../../shared/loadenv'); // load <repo>/.env before anything reads config
/**
 * asmltr-core — HTTP server + the core handle() pipeline (plan §A4/§A5).
 *
 * Pipeline:  inbound envelope
 *   → resolveIdentity → (deny if revoked)
 *   → buildSystemPrompt → moderate
 *   → resolve conversation_key→session → runTurn (local Agent SDK)
 *   → map result → outbound actions, emit telemetry the whole way.
 *
 * Endpoints:
 *   POST /v2/handle      native: body is an inbound envelope, returns actions[]
 *   POST /query          back-compat shim (exact old shape) for unmigrated channels
 *   GET  /events/stream  SSE feed of telemetry events (dashboard/CLI live view)
 *   GET  /health
 *
 * MUST run on host under PM2 (spawns local claude binary) and bind 127.0.0.1.
 */

// Headless-spawn env hygiene (mirrors eve-query-proxy's working recipe): allow
// the SDK to spawn `claude` even when launched from inside a Claude session, and
// keep nested spawning unblocked. Harmless under PM2 (these are usually unset).
// NOTE: deliberately NO ANTHROPIC_API_KEY — execution stays on the Claude subscription.
// We STRIP it from the env so agent execution can never silently go metered, even if an
// Anthropic key is configured for the moderation classifier (which resolves its key from
// the secrets provider, not this env var — see core/src/moderation.js + docs/MODERATION.md).
process.env.IS_SANDBOX = process.env.IS_SANDBOX || 'true';
delete process.env.CLAUDECODE;
delete process.env.CLAUDE_CODE_ENTRYPOINT;
delete process.env.ANTHROPIC_API_KEY;

const express = require('express');
const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');

const env = require('./envelope');
const trust = require('./trust/store'); // unified auth/trust/capability framework (replaces resolver)
const moderation = require('./moderation');
const sessions = require('./sessions');
const drafts = require('./drafts'); // shared hold-for-approval queue (any connector can opt in)
const selfUpdate = require('../../shared/update'); // self-update: detect + run (spawns an agent update session)
const { runTurn, generateTitle, generateStatus } = require('./runner');
const emitter = require('./emitter');
const { redactSecrets } = require('../../shared/redact'); // public-surface output redaction

const PORT = Number(process.env.ASMLTR_CORE_PORT || 3023);
const HOST = '127.0.0.1';
const MAX_CONCURRENT = Number(process.env.ASMLTR_CORE_CONCURRENCY || 6);

// In-process bus so /events/stream can broadcast what we also persist via emitter.
const bus = new EventEmitter();
bus.setMaxListeners(0);

/** Emit telemetry to the durable sinks AND the live SSE bus. */
function record(partial) {
  const evt = emitter.emit(partial);
  if (evt) bus.emit('event', evt);
  return evt;
}

// --- concurrency: global semaphore + per-conversation_key serialization ------
let active = 0;
const waiters = [];
const keyChains = new Map();

function acquireSlot() {
  if (active < MAX_CONCURRENT) { active++; return Promise.resolve(); }
  return new Promise((res) => waiters.push(res));
}
function releaseSlot() {
  active--;
  const next = waiters.shift();
  if (next) { active++; next(); }
}
/** Serialize turns sharing a conversation_key (mirrors Discord's processingChannels guard). */
function withKeyLock(key, fn) {
  const prev = keyChains.get(key) || Promise.resolve();
  const run = prev.then(() => fn());
  const tail = run.catch(() => {}); // tail never rejects so the chain keeps flowing
  keyChains.set(key, tail);
  tail.then(() => { if (keyChains.get(key) === tail) keyChains.delete(key); });
  return run;
}

// In-flight turns by conversation_key → AbortController, for real-time kill.
const inFlight = new Map();
function truncate(v, n = 400) { try { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + '…' : s; } catch { return ''; } }
function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((x) => (x && x.text) || (typeof x === 'string' ? x : '')).join(' ');
  return '';
}

// Channel/medium self-awareness — prepended to every system prompt so the model
// knows the USER's channel (vs its own Claude Code runtime).
const NAME = process.env.ASSISTANT_NAME || 'the assistant';
const CHANNEL_LABELS = {
  discord: 'Discord', telegram: 'Telegram', github: 'GitHub (issue thread)',
  mcp: 'an MCP client', 'eve-assistant-web': 'a web assistant app',
  'eve-assistant-native': 'a mobile assistant app', core: 'a direct API call',
};
function buildChannelAwareness(e, resolved) {
  const who = (resolved && resolved.display_name) || (e.sender && e.sender.raw_username) || 'a user';
  const scope = e.context && e.context.scope_name ? ` in "${e.context.scope_name}"` : '';
  const label = CHANNEL_LABELS[e.channel] || e.channel;
  return `MEDIUM AWARENESS — READ FIRST:
This message reached you through the asmltr "${e.channel}" connector. You are talking with ${who} over ${label}${scope}; from their side they are messaging ${NAME} on ${label}, NOT sitting in a terminal with you.
Your underlying runtime is Claude Code, but that is an internal implementation detail and is NOT the medium of this conversation. If asked what app/medium/channel/platform you're on, the truthful answer is ${label} (via the asmltr ${e.channel} connector) — do NOT say "Claude Code", "the terminal", "SSH", or describe session-start hooks / git status / system reminders as if the user sent them. Those are your backstage context, not this conversation.`;
}

/**
 * The core. Takes a validated inbound envelope, returns OutboundAction[].
 */
async function handle(envelope, opts = {}) {
  const e = env.inbound(envelope);
  const idlePolicy = e.delivery === 'sync' ? 'infinite' : 'infinite';

  const _cc = e.channel_context || {};
  record({ surface: e.channel, session_id: e.conversation_key, event_type: 'inbound',
    identity: e.sender.raw_username || e.sender.raw_id, source: 'core',
    payload: { text: e.content.text.slice(0, 500), delivery: e.delivery, server: _cc.server || null, channel: _cc.channel || null } });

  // 0) takeover guard: if a human has claimed this session in a terminal, pause
  //    channel responses (don't run a turn) until released.
  const claimed = sessions.get(e.conversation_key);
  if (claimed && claimed.claim_state === 'terminal-claimed') {
    record({ surface: e.channel, session_id: e.conversation_key, event_type: 'control',
      identity: claimed.claimed_by, source: 'core', payload: { action: 'paused-by-claim' } });
    return [env.status('This conversation is being handled directly in a terminal right now.')];
  }

  // 1) identity / trust (unified framework — context-scoped, default-deny)
  const resolved = trust.resolve(e);
  e.resolved = resolved;
  record({ surface: e.channel, session_id: e.conversation_key, event_type: 'identity_resolved',
    identity: resolved.user_key, source: 'core',
    payload: { trust_tier: resolved.trust_tier, bypass: resolved.bypass_moderation, revoked: resolved.revoked } });

  if (resolved.revoked) {
    record({ surface: e.channel, session_id: e.conversation_key, event_type: 'moderation_decision',
      identity: resolved.user_key, source: 'core', payload: { decision: 'REVOKED' } });
    return [env.reply('Access has been revoked for this account.')];
  }

  // 2) system prompt + moderation
  // Medium awareness FIRST (applies to every channel) — the model's runtime is
  // Claude Code, but the USER is on this connector's channel. Without this, "what
  // are we talking over?" gets answered as terminal/SSH/CLI instead of the channel.
  let systemPrompt = buildChannelAwareness(e, resolved) + '\n\n' + trust.buildAuthzPrompt(resolved, e.channel);
  if (e.system_prompt_extra) systemPrompt += '\n\n' + e.system_prompt_extra; // connector-supplied context (e.g. Discord)
  if (process.env.ASMLTR_SELF_AWARE !== 'off') { // make the session aware of the asmltr toolbelt
    systemPrompt += '\n\nASMLTR TOOLBELT — you run inside asmltr, a multi-session assistant backend on this machine. ' +
      'You have an `asmltr` CLI (run `asmltr help` for everything). Key cross-session ops (use the Bash tool):\n' +
      '• `asmltr ls` (active sessions) · `asmltr map` (grouped by working dir) · `asmltr who <path>` (who recently touched a file/dir) — check these before duplicating work another session is already doing.\n' +
      '• `asmltr send <channel> <target> "<text>"` — deliver output through ANOTHER connector (discord|telegram|…; target = id/alias). ' +
      'COPY (here + there): run it, then reply normally. REDIRECT (only there): run it, then reply with exactly [[NO_REPLY]] so nothing posts here. ' +
      'To send a FILE/attachment (image, PDF, any file) on a channel that supports it: `asmltr send <channel> <target> --file <abs-path> [--caption "…"]`.\n' +
      '• `asmltr announce "<text>" [--to <target>] [--urgent] [--ttl <sec>]` — post an awareness note delivered into other sessions on their next turn; `asmltr announcements` lists live ones.\n' +
      'Use these when asked to route/coordinate, or to stay aware of the other sessions running alongside you.';
    // Mesh steer is a COERCIVE verb — only advertise it when the operator has enabled it, and always
    // teach the announce-vs-steer distinction so it's used deliberately, not reflexively.
    if (/^(1|on|true|yes)$/i.test(process.env.ASMLTR_MESH_STEER || '')) {
      systemPrompt += '\n• `asmltr steer <session-key> "<guidance>" [--from <you>] [--interrupt]` — push guidance ' +
        'directly into ANOTHER session\'s LIVE turn. This is fundamentally different from `announce`: **announce** ' +
        'is an advisory note the other session sees on its NEXT turn and decides for itself whether to act on; ' +
        '**steer** overrides what that session is doing RIGHT NOW and makes it act on your guidance (`--interrupt` ' +
        'abandons its current turn; without it, your guidance is applied after the current turn finishes). Steer is ' +
        'coercive — it spends the other session\'s turn. Use it sparingly for time-sensitive redirection; prefer ' +
        'announce for everything else. Never steer a session into a loop (don\'t steer one that\'s steering you).';
    }
    // If THIS channel supports attachments, tell the agent exactly how — so it never claims it can't.
    if (e.capabilities && e.capabilities.supports_attachments_out) {
      const chTarget = (e.channel_context && (e.channel_context.channelId || e.channel_context.chatId || e.channel_context.target)) || '<this channel id>';
      systemPrompt += `\n\nATTACHMENTS: THIS channel supports sending files. To attach a file HERE, write/produce it to a path, then run \`asmltr send ${e.channel} ${chTarget} --file <abs-path> [--caption "…"]\`. Do NOT tell the user you can't attach files here or fall back to another channel — you can.`;
    }
  }
  // Cross-channel file uploads: every file a user sends on ANY channel is saved to one shared
  // area (see shared/uploads.js), so "find the thing I sent" works even when it arrived on a
  // different channel/app. Trust-gated: only full-trust (owner) sessions are told about the
  // upload area + shown the recent file list — don't leak the owner's files to lesser callers.
  if (resolved.bypass_moderation) {
    systemPrompt += '\n\nFILE UPLOADS (shared across ALL channels): every file a user sends on any channel ' +
      '(Telegram, Discord, …) is saved to ONE shared upload area, tagged with its origin channel. When the user ' +
      'refers to a file they sent/uploaded/shared — even "on Telegram" or from another app — DO NOT claim you ' +
      'can\'t find it before checking here: run `asmltr uploads` (newest first; also `asmltr uploads <search>`, ' +
      '`--channel <name>`, `--since <2h|1d>`), then Read the file at the path it prints.';
    try {
      const recent = require('../../shared/uploads').recentSummary(6);
      if (recent) systemPrompt += `\n\nRecent uploads (newest first):\n${recent}`;
    } catch (_) {}
  }

  // Cross-session announcements: drain any this session hasn't seen into its context (with
  // timestamps) — awareness from other sessions on this machine, delivered on this next turn.
  try {
    const anns = sessions.drainAnnouncements(e.conversation_key, e.channel, resolved.user_key);
    if (anns.length) {
      const fmt = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
      const lines = anns.map((a) => `• [${fmt(a.created_at)}${a.priority === 'urgent' ? ' · URGENT' : ''}${a.from_session ? ' · from ' + a.from_session : ''}] ${a.text}`);
      systemPrompt += `\n\n📢 ANNOUNCEMENTS from other sessions on this machine (awareness only — act on them just if relevant to what you're doing):\n${lines.join('\n')}`;
      record({ surface: e.channel, session_id: e.conversation_key, event_type: 'control', identity: resolved.user_key, source: 'core', payload: { action: 'announcements-received', count: anns.length } });
    }
  } catch (_) {}
  const mod = await moderation.moderate(e.content.text, resolved, { platform: e.channel });
  record({ surface: e.channel, session_id: e.conversation_key, event_type: 'moderation_decision',
    identity: resolved.user_key, source: 'core',
    payload: { decision: mod.allowed ? 'ALLOW' : 'BLOCK', riskLevel: mod.riskLevel, monitored: !!mod.monitored, bypassed: !!mod.bypassed } });

  if (!mod.allowed) {
    if (mod.riskLevel >= 7) await moderation.notifyBlock(resolved, e.content.text, mod, e.channel);
    return [env.reply('This request has been flagged by the security system and was not processed.')];
  }

  // 3) session resolution + run
  const isNew = !sessions.get(e.conversation_key)?.engine_session_id;
  const { resume } = sessions.resolveForTurn(e.conversation_key, e.channel, idlePolicy, e.working_dir || undefined);
  const sessionRow = sessions.get(e.conversation_key);
  const cwd = sessionRow?.working_dir || undefined; // spawn/resume cwd (neutral /root by default)
  if (isNew) {
    record({ surface: e.channel, session_id: e.conversation_key, event_type: 'session-start',
      identity: resolved.user_key, source: 'core', payload: { channel: e.channel } });
  }

  // Remember where an out-of-band operator inject should reply (via the manager's /send):
  // instance id = 2nd segment of the conversation_key; target = the channel/chat id.
  try {
    const outInstance = String(e.conversation_key).split(':')[1] || null;
    const outTarget = (e.channel_context && (e.channel_context.channelId || e.channel_context.chatId || e.channel_context.target)) || null;
    if (outInstance && outTarget) sessions.setOutboundRoute(e.conversation_key, outInstance, outTarget);
  } catch (_) {}

  // Redaction applies on public surfaces or for any non-full-trust recipient. Computed NOW (not
  // just at the output stage) so STREAMED deltas can be masked in-flight — a secret is never shipped.
  const mustRedact = !!e.public || !resolved.bypass_moderation;
  // Streaming (opts.onText): emit assistant text as the SDK produces it. When redacting, only ship up
  // to the last WHITESPACE boundary — so a secret is a complete token (redactSecrets masks it) before
  // it goes out, and we never emit a still-forming token. Full-trust recipients stream raw (no lag).
  let _streamRaw = '', _emitted = 0;
  const _pushDelta = (raw) => {
    _streamRaw += raw;
    const red = mustRedact ? redactSecrets(_streamRaw).text : _streamRaw;
    let end = red.length;
    if (mustRedact) { const b = Math.max(red.lastIndexOf(' '), red.lastIndexOf('\n')); end = b >= 0 ? b + 1 : _emitted; }
    if (end > _emitted) { try { opts.onText(red.slice(_emitted, end)); } catch (_) {} _emitted = end; }
  };
  const _flushStream = () => {
    if (!opts.onText) return;
    const red = mustRedact ? redactSecrets(_streamRaw).text : _streamRaw;
    if (/\[\[NO_REPLY\]\]/i.test(red)) return; // don't ship the silence sentinel
    if (red.length > _emitted) { try { opts.onText(red.slice(_emitted)); } catch (_) {} _emitted = red.length; }
  };
  // Step streaming (opts.onSegment/onTool/onThinking): a step consumer (e.g. Discord) posts each
  // COMPLETED narration block / tool call as it lands — not token-by-token. Segments and thinking
  // are complete blocks, so we redact each whole (no boundary dance) before it leaves the core.
  const _pushSegment = (seg) => { try { opts.onSegment(mustRedact ? redactSecrets(seg).text : seg); } catch (_) {} };
  const _pushThinking = (t) => { try { opts.onThinking(mustRedact ? redactSecrets(t).text : t); } catch (_) {} };

  const abortController = new AbortController();
  inFlight.set(e.conversation_key, abortController);
  let result;
  try {
    // image attachments → vision (runner builds SDK image content blocks)
    const images = (e.content.attachments || [])
      .filter((a) => a && a.type === 'image' && a.data && a.media_type)
      .map((a) => ({ media_type: a.media_type, data: a.data }));
    result = await runTurn({
      prompt: e.content.text,
      systemPrompt,
      resume,
      cwd,
      abortController,
      images,
      onDelta: opts.onText ? _pushDelta : undefined,
      onSegment: opts.onSegment ? _pushSegment : undefined,
      onTool: opts.onTool ? ((t) => { try { opts.onTool(t); } catch (_) {} }) : undefined,
      onThinking: opts.onThinking ? _pushThinking : undefined,
      onEvent: (sdkEvt) => {
        const base = { surface: e.channel, session_id: e.conversation_key, identity: resolved.user_key, source: 'core' };
        if (sdkEvt.type === 'assistant') {
          for (const c of sdkEvt.message?.content || []) {
            if (c.type === 'tool_use') record({ ...base, event_type: 'tool', payload: { tool: c.name, input: truncate(c.input, 4000) } });
            else if (c.type === 'thinking') record({ ...base, event_type: 'thinking', payload: { text: truncate(c.thinking || c.text, 2000) } });
          }
        } else if (sdkEvt.type === 'user') {
          for (const c of sdkEvt.message?.content || []) {
            // store generous tool output so the TUI watch view can show it in full (cap guards DB bloat)
            if (c.type === 'tool_result') record({ ...base, event_type: 'tool_result', payload: { output: truncate(toolResultText(c.content), 16000), is_error: !!c.is_error } });
          }
        }
      },
    });
  } catch (err) {
    // If the operator stopped or steered this turn (Stop button / a steer with interrupt),
    // its AbortController fires and the SDK throws. That's not a failure — stay SILENT so the
    // connector posts nothing (the steer, if any, delivers the real reply). Re-throw anything else.
    if (abortController.signal.aborted) {
      record({ surface: e.channel, session_id: e.conversation_key, event_type: 'control',
        identity: resolved.user_key, source: 'core', payload: { action: 'aborted', silent: true } });
      return []; // no actions → connector drops it (no "I hit an error")
    }
    throw err;
  } finally {
    inFlight.delete(e.conversation_key);
  }
  _flushStream(); // ship any redacted tail held back during streaming

  if (result.engineSessionId) sessions.recordEngineId(e.conversation_key, result.engineSessionId);
  sessions.touch(e.conversation_key);

  record({ surface: e.channel, session_id: e.conversation_key, event_type: 'token-usage',
    identity: resolved.user_key, source: 'core',
    tokens_in: result.usage.tokens_in, tokens_out: result.usage.tokens_out, cost_usd: result.usage.cost_usd,
    payload: { tools: result.tools.length, isError: result.isError } });

  // Universal silence sentinel: if the turn ends with [[NO_REPLY]] (e.g. the agent rerouted its
  // answer to another channel via `asmltr send` and doesn't want to post here), emit no action so
  // EVERY connector stays quiet — not just Discord. Enables cross-channel "redirect".
  if (/\[\[NO_REPLY\]\]/i.test(result.text || '')) {
    record({ surface: e.channel, session_id: e.conversation_key, event_type: 'control',
      identity: resolved.user_key, source: 'core', payload: { action: 'no-reply' } });
    return [];
  }

  const actions = [env.reply(result.text || "I'm here — what would you like to know?", { segments: result.segments || [] })];
  record({ surface: e.channel, session_id: e.conversation_key, event_type: 'outbound',
    identity: resolved.user_key, source: 'core', payload: { text: truncate(result.text, 500), chars: (result.text || '').length } });

  // --- REDACTION LAYER (output stage, mirrors the trust/auth input stage) -----
  // Scrub secrets from outbound text on any surface that ISN'T a private channel with
  // a full-trust user: public surfaces (github comments, discord channels) always
  // redact; private 1:1 surfaces redact unless the recipient is full-trust (the owner).
  // Telemetry above stays RAW — the operator TUI is a private, full-trust surface.
  // (mustRedact was computed up-front so streaming deltas could be masked in-flight too.)
  if (mustRedact) {
    let masked = 0;
    for (const a of actions) {
      if (a.type !== 'reply') continue;
      const r = redactSecrets(a.text); a.text = r.text; masked += r.count;
      if (Array.isArray(a.segments)) a.segments = a.segments.map((s) => { const x = redactSecrets(s); masked += x.count; return x.text; });
    }
    if (masked) record({ surface: e.channel, session_id: e.conversation_key, event_type: 'control',
      identity: resolved.user_key, source: 'core', payload: { action: 'redacted', count: masked, public: !!e.public } });
  }

  // --- DRAFT / APPROVAL GATE ---------------------------------------------------
  // If the connector attached an approval policy and it says HOLD for this recipient, divert the
  // (already-redacted) reply into the shared draft store instead of returning it. The connector
  // then sends nothing; the draft surfaces on the dashboard + `asmltr drafts` for approve/discard.
  // Generic — any connector opts in by setting e.approval = { policy, recipient, subject, attachments }.
  if (e.approval && drafts.shouldHold(e.approval.policy, resolved)) {
    const replyAction = actions.find((a) => a.type === 'reply');
    const bodyText = replyAction ? replyAction.text : '';
    if (bodyText.trim()) {
      const d = drafts.create({
        channel: e.channel, instanceId: String(e.conversation_key).split(':')[1] || null,
        conversationKey: e.conversation_key, recipient: e.approval.recipient || null,
        subject: e.approval.subject || null, body: bodyText, attachments: e.approval.attachments || [],
        reason: `policy=${e.approval.policy} tier=${resolved.trust_tier}`,
      });
      record({ surface: e.channel, session_id: e.conversation_key, event_type: 'notification',
        identity: resolved.user_key, source: 'core',
        payload: { kind: 'draft', draft_id: d.id, recipient: d.recipient, subject: d.subject, preview: truncate(bodyText, 280) } });
      return [{ type: 'drafted', draft_id: d.id }]; // connector delivers nothing to the recipient
    }
  }
  return actions;
}

/** Deliver text (+ optional files) OUT through a connector instance, via the manager's unified /send. */
async function deliverOut({ instanceId, target, text, files, subject, ref }) {
  const mgr = (process.env.ASMLTR_MANAGER_URL || 'http://127.0.0.1:3024').replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.ASMLTR_MANAGER_TOKEN) headers.Authorization = 'Bearer ' + process.env.ASMLTR_MANAGER_TOKEN;
  const post = (body) => fetch(`${mgr}/send`, { method: 'POST', headers, body: JSON.stringify(body) });
  // subject/ref are email-threading hints; other connectors ignore them.
  if (text && text.trim()) { const r = await post({ instance_id: instanceId, target, kind: 'text', text, subject, ref }); if (!r.ok) throw new Error(`send ${r.status}`); }
  for (const p of files || []) { const r = await post({ instance_id: instanceId, target, kind: 'file', path: p, subject, ref }); if (!r.ok) throw new Error(`send file ${r.status}`); }
}

/** Run handle() under the concurrency slot + per-key lock. */
function dispatch(envelope, opts) {
  const key = envelope.conversation_key || 'anon';
  return withKeyLock(key, async () => {
    await acquireSlot();
    try { return await handle(envelope, opts); }
    finally { releaseSlot(); }
  });
}

// --- HTTP --------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'asmltr-core', active }));
// Build identity — the code sha this process is running + when it started. An updater checks this
// (not just /health, which returns 200 even on stale code) to confirm the restart actually landed.
const BUILD_SHA = (() => { try { return require('child_process').execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim(); } catch (_) { return 'unknown'; } })();
const STARTED_AT = new Date().toISOString();
app.get('/version', (req, res) => res.json({ service: 'asmltr-core', sha: BUILD_SHA, started_at: STARTED_AT, pid: process.pid }));

// The dashboard is a browser CONNECTOR: it posts `eve-assistant-web` envelopes but must not
// hardcode who the operator is (the repo is generic). Resolve the sender identity server-side
// from config or the reverse proxy's Authelia-resolved user, so the same build works anywhere.
// The browser sends a placeholder sender; we overwrite raw_id with the real owner here.
function normalizeWebSender(req) {
  const b = req.body;
  if (!b || b.channel !== 'eve-assistant-web') return;
  const owner = process.env.ASMLTR_WEB_OWNER_ID || req.get('X-Remote-User');
  if (owner) b.sender = { ...(b.sender || {}), raw_id: String(owner), raw_username: (b.sender && b.sender.raw_username) || 'dashboard' };
}

// Attach a browser-uploaded file to the shared upload surface (Phase B of the web chat). Body is
// JSON { channel, filename, mime, conversation_key?, data_base64 } — base64 keeps it within the
// existing express.json body (no multipart dep). Returns the manifest record incl. absolute path,
// which the chat composer then references in the next message so the agent can Read it.
app.post('/v2/upload', (req, res) => {
  try {
    const { filename, mime, conversation_key, data_base64 } = req.body || {};
    if (!data_base64 || typeof data_base64 !== 'string') return res.status(400).json({ error: 'data_base64 required' });
    const buffer = Buffer.from(data_base64, 'base64');
    if (!buffer.length) return res.status(400).json({ error: 'empty file' });
    const owner = process.env.ASMLTR_WEB_OWNER_ID || req.get('X-Remote-User') || 'dashboard';
    const rec = require('../../shared/uploads').save({
      channel: 'eve-assistant-web', buffer, filename, mime,
      sender: 'dashboard', senderId: String(owner), conversationKey: conversation_key || null,
      kind: /^image\//.test(mime || '') ? 'image' : 'document',
    });
    record({ surface: 'eve-assistant-web', session_id: conversation_key || null, event_type: 'control',
      identity: String(owner), source: 'core', payload: { action: 'upload', name: rec.filename, path: rec.path, bytes: buffer.length } });
    res.json({ ok: true, file: { path: rec.path, name: rec.filename, mime: rec.mime || mime || null, kind: rec.kind, bytes: buffer.length } });
  } catch (err) {
    console.error('[core] /v2/upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Streaming turn: same pipeline as /v2/handle, but assistant text is streamed as it's produced.
// SSE frames: {type:'delta', text} … then {type:'done', actions}. Deltas are redacted in-flight.
app.post('/v2/stream', async (req, res) => {
  normalizeWebSender(req);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const frame = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (_) {} };
  try {
    const actions = await dispatch(req.body, {
      onText: (text) => { if (text) frame({ type: 'delta', text }); },            // token stream (voice/openai)
      onSegment: (text) => { if (text) frame({ type: 'segment', text }); },        // completed narration block (step consumers)
      onTool: (t) => { if (t && t.name) frame({ type: 'tool', name: t.name }); },  // a tool call as it happens
      onThinking: (text) => { if (text) frame({ type: 'thinking', text }); },      // a completed thinking block
    });
    frame({ type: 'done', actions });
  } catch (err) {
    console.error('[core] /v2/stream error:', err.message);
    frame({ type: 'error', error: err.message });
  }
  res.end();
});

// --- DRAFTS (hold-for-approval queue, any connector) -------------------------
app.get('/v2/drafts', (req, res) => {
  const status = req.query.status || 'pending';
  res.json({ drafts: drafts.list({ status: status === 'all' ? null : status, channel: req.query.channel || null, limit: Number(req.query.limit) || 50 }), pending: drafts.pendingCount() });
});
app.get('/v2/drafts/:id', (req, res) => {
  const d = drafts.get(Number(req.params.id));
  return d ? res.json(d) : res.status(404).json({ error: 'unknown draft' });
});
app.post('/v2/drafts/:id/approve', async (req, res) => {
  const d = drafts.get(Number(req.params.id));
  if (!d) return res.status(404).json({ error: 'unknown draft' });
  if (d.status !== 'pending') return res.status(409).json({ error: `draft is already ${d.status}` });
  if (!d.instance_id || !d.recipient) return res.status(422).json({ error: 'draft has no delivery route (instance_id/recipient)' });
  try {
    await deliverOut({ instanceId: d.instance_id, target: d.recipient, text: d.body, files: d.attachments, subject: d.subject, ref: d.conversation_key });
    drafts.setStatus(d.id, 'sent');
    record({ surface: d.channel, session_id: d.conversation_key, event_type: 'outbound', identity: 'operator', source: 'core', payload: { text: truncate(d.body, 500), approved_draft: d.id } });
    res.json({ ok: true, sent: d.id });
  } catch (e) { res.status(502).json({ error: 'delivery failed: ' + e.message }); }
});
app.post('/v2/drafts/:id/discard', (req, res) => {
  const ok = drafts.setStatus(Number(req.params.id), 'discarded');
  return ok ? res.json({ ok: true, discarded: Number(req.params.id) }) : res.status(409).json({ error: 'draft not pending or unknown' });
});

app.post('/v2/handle', async (req, res) => {
  try {
    const actions = await dispatch(req.body);
    res.json({ actions });
  } catch (err) {
    console.error('[core] /v2/handle error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Back-compat shim — accepts the exact eve-query-proxy /query request shape so
// unmigrated channels keep working. Maps the old sessionId to a conversation_key.
// NOTE (Phase 1): parity vs the old proxy (incl. system-prompt-wrapped messages)
// is verified by replaying recorded query-logs before any channel cuts over.
app.post('/query', async (req, res) => {
  const { message, sessionId, userId, username, platform, apiKey } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Message required' });
  const conversation_key = sessionId || `shim:${platform || 'core'}:${randomUUID()}`;
  try {
    const actions = await dispatch({
      channel: platform || 'core',
      conversation_key,
      sender: { raw_id: userId || username || 'unknown', raw_username: username, api_key: apiKey },
      content: { text: message },
      delivery: 'sync',
    });
    const reply = actions.find((a) => a.type === 'reply');
    res.json({ response: reply ? reply.text : '', sessionId: conversation_key });
  } catch (err) {
    console.error('[core] /query error:', err.message);
    res.status(500).json({ error: 'asmltr-core error', details: err.message, sessionId: conversation_key });
  }
});

// Live telemetry feed (dashboard + asmltr CLI).
app.get('/events/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.write(`data: ${JSON.stringify({ type: 'connected', ts: Date.now() })}\n\n`);
  const onEvent = (evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`);
  bus.on('event', onEvent);
  req.on('close', () => bus.off('event', onEvent));
});

// --- takeover primitive (plan §B6): claim/release a conversation session so the
//     terminal (or dashboard) can resume it in tmux while the channel pauses. ---
app.get('/v2/session/:key', (req, res) => {
  const row = sessions.get(req.params.key);
  if (!row) return res.status(404).json({ error: 'unknown session' });
  res.json(row);
});

app.post('/v2/claim', (req, res) => {
  const { conversation_key, by } = req.body || {};
  const row = sessions.get(conversation_key);
  if (!row) return res.status(404).json({ error: 'unknown session' });
  if (!row.engine_session_id) return res.status(409).json({ error: 'session has no engine id yet (no turns run)' });
  // Mark claimed; the per-key lock means no NEW channel turn starts while claimed.
  sessions.setClaim(conversation_key, 'terminal-claimed', by || 'terminal');
  record({ surface: row.channel, session_id: conversation_key, event_type: 'control',
    identity: by || 'terminal', source: 'core', payload: { action: 'claim', by } });
  res.json({ conversation_key, engine_session_id: row.engine_session_id, working_dir: row.working_dir || process.cwd(), claim_state: 'terminal-claimed' });
});

// Real-time stop: abort the in-flight turn (the session survives + is resumable).
// Generate a short session title from conversation text (cheap, fast, no-tools SDK call).
// Serialized behind a small limiter by the caller (the collector); one at a time here is fine.
let _titleBusy = false;
app.post('/v2/title', async (req, res) => {
  const text = req.body && req.body.text;
  if (!text) return res.status(400).json({ error: 'need text' });
  if (_titleBusy) return res.status(429).json({ error: 'busy' });
  _titleBusy = true;
  try {
    const title = await generateTitle(text);
    res.json({ ok: true, title });
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { _titleBusy = false; }
});

// Live "what is this session doing right now" rollup — the rolling counterpart to /v2/title.
let _statusBusy = false;
app.post('/v2/status', async (req, res) => {
  const text = req.body && req.body.text;
  if (!text) return res.status(400).json({ error: 'need text' });
  if (_statusBusy) return res.status(429).json({ error: 'busy' });
  _statusBusy = true;
  try {
    const status = await generateStatus(text);
    res.json({ ok: true, status });
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { _statusBusy = false; }
});

// --- self-update ------------------------------------------------------------
app.get('/v2/update/status', async (req, res) => res.json(await selfUpdate.getUpdateStatus({ fetch: req.query.fetch !== '0' })));
app.get('/v2/update/auto', (req, res) => res.json({ auto: selfUpdate.isAutoUpdate() }));
app.post('/v2/update/auto', (req, res) => res.json({ auto: selfUpdate.setAutoUpdate(!!(req.body && req.body.enabled)) }));
// Kick off a self-update: spawns a DETACHED agent session that runs UPDATE-WITH-AGENT.md and
// restarts via restart-with-rollback.sh (auto-rollback on failure). Returns immediately.
app.post('/v2/update/run', (req, res) => {
  try {
    const r = selfUpdate.spawnUpdateSession();
    record({ surface: 'core', session_id: 'self-update', event_type: 'control', identity: (req.body && req.body.by) || 'operator', source: 'core', payload: { action: 'self-update-started', pid: r.pid } });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cross-session announcement mailbox: post an awareness note delivered into other sessions'
// context on their next turn. { text, target?, priority?, from?, ttl? (seconds) }
app.post('/v2/announce', (req, res) => {
  const { text, target, priority, from, ttl } = req.body || {};
  if (!text) return res.status(400).json({ error: 'need text' });
  const r = sessions.addAnnouncement({ text: String(text), target: target || '*', priority, from_session: from || null, ttlSec: ttl ? Number(ttl) : null });
  record({ surface: 'core', session_id: null, event_type: 'control', identity: from || 'operator', source: 'core',
    payload: { action: 'announce', id: r.id, target: target || '*', priority: priority || 'normal', text: truncate(text, 200) } });
  res.json({ ok: true, id: r.id, created_at: r.created_at, target: target || '*' });
});
app.get('/v2/announcements', (req, res) => res.json({ announcements: sessions.listAnnouncements() }));

app.post('/v2/abort', (req, res) => {
  const key = req.body && req.body.conversation_key;
  // The self-update session is a SEPARATE process (not core inFlight) — stop it via its kill file,
  // which it polls between steps. Lets the existing overlay Stop button abort the update too.
  if (typeof key === 'string' && key.startsWith('self-update')) {
    try {
      const os = require('os'), fsm = require('fs'), pth = require('path');
      const f = pth.join(os.homedir(), '.asmltr', 'self-update.kill');
      fsm.mkdirSync(pth.dirname(f), { recursive: true }); fsm.writeFileSync(f, 'kill ' + Date.now());
    } catch (_) {}
    record({ surface: 'core', session_id: key, event_type: 'control', identity: 'operator', source: 'core', payload: { action: 'abort-self-update' } });
    return res.json({ ok: true, aborted: key, via: 'kill-file' });
  }
  const ctrl = inFlight.get(key);
  if (!ctrl) return res.status(404).json({ ok: false, error: 'no in-flight turn for that conversation' });
  ctrl.abort();
  record({ surface: 'core', session_id: key, event_type: 'control', identity: 'operator', source: 'core', payload: { action: 'abort' } });
  res.json({ ok: true, aborted: key });
});

// Operator STEER: inject a message into a live session — resume it with the operator's text, then
// route the reply back to the origin channel via the manager's /send (works for ANY connector,
// since /send is unified). Stops any in-flight turn first (steer replaces the current generation).
// Bypasses moderation (the operator is trusted). Redacts on the way out like any public reply.
app.post('/v2/inject', (req, res) => {
  const { conversation_key: key, text, by, interrupt } = req.body || {};
  if (!key || !text) return res.status(400).json({ error: 'need conversation_key + text' });
  // MESH STEER (`by: "mesh:<label>"`) = one SESSION steering another. Unlike the advisory `announce`
  // mailbox (a note the peer sees next turn and decides whether to act on), a steer is COERCIVE — it
  // pushes into a live turn. It's OFF by default; the operator opts in per instance with
  // ASMLTR_MESH_STEER=on. Operator/dashboard steers (any other `by`) are always allowed.
  const meshSteer = typeof by === 'string' && by.startsWith('mesh:');
  if (meshSteer && !/^(1|on|true|yes)$/i.test(process.env.ASMLTR_MESH_STEER || '')) {
    return res.status(403).json({ error: 'mesh steer is disabled on this instance (set ASMLTR_MESH_STEER=on to allow session-to-session steering)' });
  }
  const row = sessions.get(key);
  if (!row) return res.status(404).json({ error: 'unknown session' });
  // A steer QUEUES behind any in-flight turn (withKeyLock serializes per key) so the current
  // work finishes and the steer CONTINUES it — you don't lose in-progress research and the model
  // treats the text as guidance, not a fresh question. `interrupt:true` aborts the running turn
  // first (redirect immediately, abandoning the current turn).
  const wasRunning = inFlight.has(key);
  if (interrupt && wasRunning) { try { inFlight.get(key).abort(); } catch (_) {} }

  withKeyLock(key, async () => {
    record({ surface: row.channel, session_id: key, event_type: 'control', identity: by || 'operator', source: 'core', payload: { action: 'inject', text: truncate(text, 500), interrupt: !!interrupt } });
    const { resume } = sessions.resolveForTurn(key, row.channel);
    // Mid-task steer → frame the text so the model continues its current work with this guidance
    // rather than answering it in isolation. Idle session → deliver it as a normal message.
    const steerer = meshSteer ? `Peer session "${by.slice(5)}"` : 'Operator';
    const prompt = (wasRunning || interrupt)
      ? `[${steerer} steering — you are mid-task. Incorporate the following guidance into the work you are ALREADY doing and continue it. Do NOT restart from scratch, and do NOT treat it as a standalone question to answer in isolation.]\n\n${text}`
      : text;
    const ac = new AbortController(); inFlight.set(key, ac);
    let result;
    try {
      result = await runTurn({ prompt, resume, cwd: row.working_dir || undefined, abortController: ac,
        onEvent: (sdkEvt) => {
          const base = { surface: row.channel, session_id: key, identity: by || 'operator', source: 'core' };
          if (sdkEvt.type === 'assistant') for (const c of sdkEvt.message?.content || []) {
            if (c.type === 'tool_use') record({ ...base, event_type: 'tool', payload: { tool: c.name, input: truncate(c.input, 4000) } });
            else if (c.type === 'thinking') record({ ...base, event_type: 'thinking', payload: { text: truncate(c.thinking || c.text, 2000) } });
          } else if (sdkEvt.type === 'user') for (const c of sdkEvt.message?.content || []) {
            if (c.type === 'tool_result') record({ ...base, event_type: 'tool_result', payload: { output: truncate(toolResultText(c.content), 16000), is_error: !!c.is_error } });
          }
        } });
    } finally { inFlight.delete(key); }
    if (result.engineSessionId) sessions.recordEngineId(key, result.engineSessionId);
    sessions.touch(key);
    const reply = redactSecrets((result.text || '').trim()).text;
    record({ surface: row.channel, session_id: key, event_type: 'outbound', identity: by || 'operator', source: 'core', payload: { text: truncate(reply, 500), injected: true } });

    let delivered = false, deliverErr = null;
    if (reply && row.outbound_instance_id && row.outbound_target) {
      try {
        const mgr = (process.env.ASMLTR_MANAGER_URL || 'http://127.0.0.1:3024').replace(/\/$/, '');
        const headers = { 'Content-Type': 'application/json' };
        if (process.env.ASMLTR_MANAGER_TOKEN) headers.Authorization = 'Bearer ' + process.env.ASMLTR_MANAGER_TOKEN;
        const r = await fetch(`${mgr}/send`, { method: 'POST', headers, body: JSON.stringify({ instance_id: row.outbound_instance_id, target: row.outbound_target, text: reply }) });
        delivered = r.ok; if (!r.ok) deliverErr = `send ${r.status}`;
      } catch (e) { deliverErr = e.message; }
    } else if (reply) { deliverErr = 'no stored outbound route for this session'; }
    if (!res.headersSent) res.json({ ok: true, reply, delivered, deliverErr, route: { instance_id: row.outbound_instance_id, target: row.outbound_target } });
  }).catch((e) => { if (!res.headersSent) res.status(500).json({ error: e.message }); });
});

app.post('/v2/release', (req, res) => {
  const { conversation_key } = req.body || {};
  const row = sessions.get(conversation_key);
  if (!row) return res.status(404).json({ error: 'unknown session' });
  sessions.setClaim(conversation_key, 'free', null);
  record({ surface: row.channel, session_id: conversation_key, event_type: 'control',
    identity: 'terminal', source: 'core', payload: { action: 'release' } });
  res.json({ conversation_key, claim_state: 'free' });
});

// --- trust framework CRUD (the dashboard Access page drives these) -----------
// Read-only identity resolution (connectors use this to authorize owner-only actions).
// Body: an envelope-shaped { channel, sender:{raw_id,raw_username,api_key}, context:{scope_id} }.
app.post('/trust/resolve', (req, res) => { try { res.json(trust.resolve(req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get('/trust/principals', (req, res) => res.json({ principals: trust.principals.list() }));
app.get('/trust/principals/:id', (req, res) => { const p = trust.principals.get(req.params.id); return p ? res.json(p) : res.status(404).json({ error: 'not found' }); });
app.post('/trust/principals', (req, res) => res.json(trust.principals.create(req.body)));
app.patch('/trust/principals/:id', (req, res) => { const p = trust.principals.update(req.params.id, req.body); return p ? res.json(p) : res.status(404).json({ error: 'not found' }); });
app.delete('/trust/principals/:id', (req, res) => res.json({ ok: trust.principals.remove(req.params.id) }));
// merge principal :id (the one being absorbed) INTO body.into (the survivor)
app.post('/trust/principals/:id/merge', (req, res) => {
  const merged = trust.principals.merge(req.params.id, req.body && req.body.into);
  return merged ? res.json(merged) : res.status(400).json({ error: 'merge failed — unknown or identical principals' });
});
app.post('/trust/principals/:id/identifiers', (req, res) => res.json(trust.identifiers.add(req.params.id, req.body.surface, String(req.body.value))));
app.delete('/trust/identifiers/:iid', (req, res) => res.json({ ok: trust.identifiers.remove(Number(req.params.iid)) }));
app.get('/trust/roles', (req, res) => res.json({ roles: trust.roles.list() }));
app.post('/trust/roles', (req, res) => res.json(trust.roles.upsert(req.body)));
app.delete('/trust/roles/:id', (req, res) => res.json({ ok: trust.roles.remove(req.params.id) }));
app.post('/trust/principals/:id/grants', (req, res) => res.json({ id: trust.grants.create({ ...req.body, principal_id: req.params.id }) }));
app.delete('/trust/grants/:gid', (req, res) => res.json({ ok: trust.grants.remove(Number(req.params.gid)) }));
// resolve preview (debugging "what can this person do here?")
app.post('/trust/resolve', (req, res) => res.json(trust.resolve(req.body)));

if (require.main === module) {
  const server = app.listen(PORT, HOST, () => {
    console.log(`asmltr-core listening on http://${HOST}:${PORT} (concurrency ${MAX_CONCURRENT})`);
    console.log('substrate: local Agent SDK on Max subscription (NO ANTHROPIC_API_KEY path)');
  });
  // Agent turns (research, tool loops) can run many minutes. Node's default 5-min
  // server.requestTimeout would cut the connector→core call mid-turn (surfacing as
  // "I hit an error processing that" on the channel), so we lift it. Localhost-only,
  // and /v2/abort still allows a manual kill. Configurable via ASMLTR_CORE_REQUEST_TIMEOUT_MS
  // (0 = unlimited, the default).
  server.requestTimeout = Number(process.env.ASMLTR_CORE_REQUEST_TIMEOUT_MS || 0);
  server.headersTimeout = 0;
  server.timeout = 0;
}

module.exports = { app, handle, dispatch, bus };
