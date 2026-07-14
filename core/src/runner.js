'use strict';
/**
 * asmltr-core — local Agent SDK runner (plan §A5).
 *
 * Wraps @anthropic-ai/claude-code query() (the LOCAL Agent SDK on the Max
 * subscription — NEVER an ANTHROPIC_API_KEY path). Runs one turn, maps the SDK
 * event stream into telemetry events + accumulated reply text, and captures the
 * SDK-assigned session id for resume.
 *
 * Modeled on the working production pattern in eve-assistant/claude-sdk-chat.js,
 * minus the terminal-output cleaning cruft (not needed off the structured stream).
 */

const { query } = require('@anthropic-ai/claude-agent-sdk'); // programmatic Agent SDK (the query() API
// moved here when @anthropic-ai/claude-code became CLI-only at 2.x). Bundles a current CLI runtime,
// so channel turns run the same modern models as the interactive terminal.

/**
 * Run one turn.
 * @param {object} args
 * @param {string} args.prompt          clean user message
 * @param {string} [args.systemPrompt]  appended system prompt (from resolver.buildSystemPrompt)
 * @param {string|null} [args.resume]   engine_session_id to resume, or null for new
 * @param {AbortController} [args.abortController]
 * @param {(evt:object)=>void} [args.onEvent]  per-SDK-event hook (for live streaming/telemetry)
 * @returns {Promise<{text:string, engineSessionId:string|null, tools:Array, usage:object, isError:boolean}>}
 */
async function runTurn({ prompt, systemPrompt, resume = null, cwd, abortController, onEvent, onDelta, onSegment, onTool, onThinking, images = [] }) {
  const options = {
    stream: true,
    // Full autonomy (the equivalent of --dangerously-skip-permissions): permissionMode bypass +
    // IS_SANDBOX=1 (set in server.js). The raw CLI flag is REJECTED as root on the modern CLI, so we
    // rely on bypassPermissions instead — verified to run tools with no prompts as root.
    permissionMode: 'bypassPermissions',
    // Surface full process insight: tool RESULTS arrive as `user` messages only with
    // includePartialMessages; thinking blocks appear when maxThinkingTokens > 0
    // (adaptive — trivial turns won't think, so overhead is self-limiting).
    includePartialMessages: true,
  };
  // Pin the model so channel turns match the terminal. An alias (opus/sonnet) auto-tracks the latest
  // of that tier; a full id pins exactly. Unset → the SDK default (currently the 1M-context Opus).
  if (process.env.ASMLTR_MODEL) options.model = process.env.ASMLTR_MODEL;
  const thinkTokens = Number(process.env.ASMLTR_MAX_THINKING_TOKENS ?? 4000);
  if (thinkTokens > 0) options.maxThinkingTokens = thinkTokens;
  // Spawn cwd controls which CLAUDE.md hierarchy loads (ambient context) AND where
  // the session is stored for --resume. Neutral default (/root = the assistant identity)
  // avoids project-context bleed into general channel chat.
  if (cwd) options.cwd = cwd;
  // Append our system prompt via the SDK's dedicated option. (NOT extraArgs —
  // the SDK ignores extraArgs['append-system-prompt']; appendSystemPrompt is the
  // real option. This carries channel-awareness + trust authz + connector context.)
  if (systemPrompt) options.appendSystemPrompt = systemPrompt;
  if (abortController) options.abortController = abortController;
  if (resume) options.resume = resume;

  // Vision: when the turn carries images, pass the prompt as the SDK's streaming-
  // input form (one user message with text + image content blocks) instead of a
  // bare string. images: [{ media_type, data(base64) }]. The local Agent SDK
  // forwards these to the model as real image input (verified end-to-end).
  let queryPrompt = prompt;
  if (images && images.length) {
    const content = [{ type: 'text', text: prompt || '(no text)' }];
    for (const img of images) {
      if (img && img.data && img.media_type) {
        content.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } });
      }
    }
    if (content.length > 1) {
      queryPrompt = (async function* () {
        yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content } };
      })();
    }
  }

  const response = await query({ prompt: queryPrompt, options });

  let text = '';
  const segments = []; // each assistant text block in order (tools split them) — lets a
                       // public renderer separate intermediate narration from the final answer
  let engineSessionId = resume || null;
  const tools = [];
  let usage = { tokens_in: 0, tokens_out: 0, cost_usd: 0 };
  let isError = false;

  for await (const event of response) {
    if (abortController && abortController.signal.aborted) break;
    if (onEvent) { try { onEvent(event); } catch (_) { /* never let a telemetry hook break a turn */ } }
    // Incremental assistant TEXT tokens (includePartialMessages) → live streaming out.
    if (onDelta && event.type === 'stream_event' && event.event && event.event.type === 'content_block_delta'
        && event.event.delta && event.event.delta.type === 'text_delta' && event.event.delta.text) {
      try { onDelta(event.event.delta.text); } catch (_) {}
    }

    switch (event.type) {
      case 'system':
        if (event.session_id) engineSessionId = event.session_id;
        break;
      case 'assistant':
        for (const c of event.message?.content || []) {
          // separate text blocks (they're split by tool calls) so a narration block
          // doesn't run straight into the next block ("…about.ops-hub is…")
          if (c.type === 'text' && c.text) {
            const seg = c.text.trim();
            segments.push(seg); text += (text && !text.endsWith('\n') ? '\n\n' : '') + c.text;
            // A COMPLETED assistant text block = one "step". Step consumers (Discord) post each
            // as it lands; the LAST block is the final answer. (Distinct from onDelta's tokens.)
            if (onSegment) { try { onSegment(seg); } catch (_) {} }
          } else if (c.type === 'tool_use') {
            tools.push({ id: c.id, name: c.name, input: c.input });
            if (onTool) { try { onTool({ name: c.name, input: c.input }); } catch (_) {} }
          } else if (c.type === 'thinking' && c.thinking && onThinking) {
            try { onThinking(c.thinking); } catch (_) {}
          }
        }
        break;
      case 'result':
        if (event.session_id) engineSessionId = event.session_id;
        isError = !!event.is_error;
        // Token/cost accounting — field names are defensive across SDK versions.
        if (event.usage) {
          usage.tokens_in = event.usage.input_tokens || event.usage.inputTokens || 0;
          usage.tokens_out = event.usage.output_tokens || event.usage.outputTokens || 0;
        }
        usage.cost_usd = event.total_cost_usd || event.cost_usd || 0; // ~0 on Max subscription
        if (typeof event.result === 'string' && !text) text = event.result;
        break;
      case 'error':
        isError = true;
        break;
      default:
        break;
    }
  }

  return { text: text.trim(), segments: segments.filter(Boolean), engineSessionId, tools, usage, isError };
}

/**
 * Generate a short session title from conversation text — a minimal, fast, no-tools,
 * no-resume SDK call on a cheap model (rides the same subscription; no API key). Used by
 * the collector to label session cards. Returns a cleaned ≤60-char Title Case string, or ''.
 */
async function generateTitle(text) {
  const model = process.env.ASMLTR_TITLE_MODEL || 'haiku';
  const prompt =
    'Give a concise 3-6 word title in Title Case that summarizes what the following conversation is about. ' +
    'Reply with ONLY the title — no quotes, no trailing punctuation, no preamble.\n\n---\n' +
    String(text || '').slice(0, 4000);
  // Mirror the known-good runTurn option set (stream + bypass perms), just on a cheap model.
  // A title is a single plain-text answer — no tools, no thinking needed.
  const options = {
    stream: true,
    permissionMode: 'bypassPermissions',
    model,
    maxTurns: 1,
  };
  let out = '';
  const response = await query({ prompt, options });
  for await (const ev of response) {
    if (ev.type === 'assistant') for (const c of ev.message?.content || []) if (c.type === 'text') out += c.text;
    else if (ev.type === 'result' && ev.result && !out) out += ev.result;
  }
  return out.replace(/["'`]+/g, '').replace(/\s+/g, ' ').trim().split('\n')[0].replace(/[.:;,\s]+$/, '').slice(0, 60);
}

/**
 * Generate a LIVE one-line status of what a session is currently DOING (present tense) from its
 * recent activity — the rolling counterpart to generateTitle (title = stable topic; status = what
 * it's doing now). Cheap haiku call. The collector shows it on the dashboard cards. Returns ≤80 chars.
 */
async function generateStatus(text) {
  const model = process.env.ASMLTR_STATUS_MODEL || process.env.ASMLTR_TITLE_MODEL || 'haiku';
  const prompt =
    'Give a concise 3-8 word phrase, starting with an -ing verb, that summarizes what the assistant is ' +
    'CURRENTLY working on in the following activity — e.g. "Debugging the email connector", "Testing the ' +
    'Discord streaming fix", "Waiting for user approval". This is a SUMMARY of past activity: do NOT ' +
    'continue the work, do NOT run any tools, do NOT use the word "I". Reply with ONLY the phrase — no ' +
    'preamble, no quotes, no trailing punctuation.\n\n---\n' +
    String(text || '').slice(0, 4000);
  const options = {
    stream: true, permissionMode: 'bypassPermissions',
    model, maxTurns: 1,
    // Override the agentic persona — otherwise the model reads the activity log as ITS task and
    // "continues" it in the first person ("I'll check…") instead of labeling it.
    appendSystemPrompt: 'You are ONLY a text-labeling function. You never take actions, never use tools, ' +
      'never speak in the first person, never continue or perform a task. You read a log of ANOTHER ' +
      'agent\'s activity and output a single short third-person label of what it is doing. Nothing else.',
  };
  let out = '';
  const response = await query({ prompt, options });
  for await (const ev of response) {
    if (ev.type === 'assistant') for (const c of ev.message?.content || []) if (c.type === 'text') out += c.text;
    else if (ev.type === 'result' && ev.result && !out) out += ev.result;
  }
  let s = out.replace(/["'`]+/g, '').replace(/\s+/g, ' ').trim().split('\n')[0].replace(/[.:;,\s]+$/, '');
  // Defensive: if a first-person continuation still leaks through, strip the lead-in.
  s = s.replace(/^(let me|i['’]?ll|i['’]?ve|i['’]?m|i am|i will|i need to|i should|i)\s+/i, '');
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (s.length > 80) s = s.slice(0, 80).replace(/\s+\S*$/, ''); // trim to a word boundary, not mid-word
  return s;
}

module.exports = { runTurn, generateTitle, generateStatus };
