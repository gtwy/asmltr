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

const { query } = require('@anthropic-ai/claude-code');

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
async function runTurn({ prompt, systemPrompt, resume = null, cwd, abortController, onEvent, images = [] }) {
  const options = {
    stream: true,
    permissionMode: 'bypassPermissions', // works under root via SDK (CLI flag does not — see eve-query-proxy.js:489)
    extraArgs: { 'dangerously-skip-permissions': true },
    // Surface full process insight: tool RESULTS arrive as `user` messages only with
    // includePartialMessages; thinking blocks appear when maxThinkingTokens > 0
    // (adaptive — trivial turns won't think, so overhead is self-limiting).
    includePartialMessages: true,
  };
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

    switch (event.type) {
      case 'system':
        if (event.session_id) engineSessionId = event.session_id;
        break;
      case 'assistant':
        for (const c of event.message?.content || []) {
          // separate text blocks (they're split by tool calls) so a narration block
          // doesn't run straight into the next block ("…about.ops-hub is…")
          if (c.type === 'text' && c.text) { segments.push(c.text.trim()); text += (text && !text.endsWith('\n') ? '\n\n' : '') + c.text; }
          else if (c.type === 'tool_use') tools.push({ id: c.id, name: c.name, input: c.input });
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

module.exports = { runTurn };
