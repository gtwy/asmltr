// Shared collector-event → chat-row mapping. One source of truth for how a session's events render as
// a transcript, reused by the floating session chat (SessionDetail) and the Schedules last-run view.
import { fmtNum } from '@/lib/format'
import { parsePayload } from '@/services/api'

export function stringify(v) {
  if (v == null) return ''
  return typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v)
}

// Map one collector event to a chat row: { kind: 'user'|'assistant'|'activity', ... }.
export function eventRow(e) {
  const p = e._payload || parsePayload(e.payload) || {}
  switch (e.event_type) {
    case 'inbound': return { kind: 'user', text: p.text, ts: e.ts }
    case 'outbound': return { kind: 'assistant', text: p.text || (p.chars != null ? `(${p.chars} chars)` : ''), ts: e.ts }
    case 'thinking': return { kind: 'activity', icon: '💭', label: 'thinking', text: p.text, ts: e.ts }
    case 'tool': return { kind: 'activity', icon: '🔧', label: p.tool || 'tool', text: stringify(p.input), mono: true, ts: e.ts }
    case 'tool_result': return { kind: 'activity', icon: p.is_error ? '⚠' : '📥', label: p.is_error ? 'error' : 'result', text: stringify(p.output), mono: true, err: !!p.is_error, ts: e.ts }
    case 'moderation_decision': return { kind: 'activity', icon: '🛡', label: `moderation · ${p.decision || ''}`.trim(), text: p.riskLevel != null ? `risk ${p.riskLevel}` : (p.reason || ''), ts: e.ts }
    case 'control': return { kind: 'activity', icon: '⚙', label: `control · ${p.action || ''}`.trim(), text: p.by ? `by ${p.by}` : (p.text || ''), ts: e.ts }
    case 'token-usage': return { kind: 'activity', icon: '∑', label: 'tokens', text: `${fmtNum(e.tokens_in)}→${fmtNum(e.tokens_out)}${p.tools != null ? ` · ${p.tools} tools` : ''}`, ts: e.ts }
    case 'session-start': return { kind: 'activity', icon: '●', label: 'session start', text: '', ts: e.ts }
    case 'notification': return { kind: 'activity', icon: '🔔', label: p.kind || 'notification', text: p.preview || p.subject || '', ts: e.ts }
    default: return { kind: 'activity', icon: '·', label: e.event_type, text: p.text || p.decision || p.action || '', ts: e.ts }
  }
}
