// Thin REST client for the asmltr collector. All calls go through the Vite
// proxy (/api -> http://127.0.0.1:3017) so this works in dev and behind a
// reverse proxy later without code changes.

async function get(path, params) {
  const qs = params
    ? '?' +
      new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
      ).toString()
    : ''
  const res = await fetch(`/api${path}${qs}`, {
    headers: { Accept: 'application/json' }
  })
  if (!res.ok) {
    throw new Error(`GET /api${path} -> ${res.status} ${res.statusText}`)
  }
  return res.json()
}

export const api = {
  sessions: (params = { active: 1 }) => get('/sessions', params),
  events: (params = {}) => get('/events', params),
  usage: (params = {}) => get('/usage', params),
  system: (params = {}) => get('/system', params),
  notifications: () => get('/notifications'),
  brief: () => get('/brief'),
  search: (q) => get('/search', { q })
}

// Control plane on the CORE (served at root under /v2/...). Used by the live
// "conversation details" pane to take over a session: abort the in-flight turn,
// or inject an operator message (the reply routes back to the origin channel).
async function postCore(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body || {})
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error || `POST ${path} -> ${res.status} ${res.statusText}`)
  return json
}

export const control = {
  // SDK/channel sessions → the core control plane
  abort: (conversation_key) => postCore('/v2/abort', { conversation_key }),
  inject: (conversation_key, text) => postCore('/v2/inject', { conversation_key, text, by: 'dashboard' }),
  // interactive `asmltr claude` (tmux) sessions → collector send-keys (steer / interrupt)
  sendText: (session_id, text) => postCore('/api/control/send-keys', { session_id, text, enter: true }),
  sendKey: (session_id, keys) => postCore('/api/control/send-keys', { session_id, keys })
}

// payload arrives as a JSON *string* over REST. Be defensive.
export function parsePayload(payload) {
  if (payload == null) return null
  if (typeof payload === 'object') return payload
  try {
    return JSON.parse(payload)
  } catch {
    return { _raw: String(payload) }
  }
}
