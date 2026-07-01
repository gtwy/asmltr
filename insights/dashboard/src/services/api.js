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
  brief: () => get('/brief')
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
