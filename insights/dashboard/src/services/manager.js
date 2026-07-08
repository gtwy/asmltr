// REST client for the asmltr connector manager (the control plane for
// comms-channel connector instances). All calls go through the /manager prefix:
//   dev:  Vite proxy /manager -> http://127.0.0.1:3024 (path rewritten, no token)
//   prod: nginx /manager/ -> host.docker.internal:3024 (+ bearer manager token)
// so this module never has to know about auth or host details.

async function request(method, path, body) {
  const opts = {
    method,
    headers: { Accept: 'application/json' }
  }
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }
  const res = await fetch(`/manager${path}`, opts)
  let data = null
  const text = await res.text()
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = { _raw: text }
    }
  }
  if (!res.ok) {
    const msg = (data && data.error) || `${method} /manager${path} -> ${res.status} ${res.statusText}`
    throw new Error(msg)
  }
  return data
}

export const manager = {
  // discovery
  types: () => request('GET', '/types'),

  // instances CRUD
  instances: () => request('GET', '/instances'),
  instance: (id) => request('GET', `/instances/${id}`),
  logs: (id) => request('GET', `/instances/${id}/logs`),
  create: (payload) => request('POST', '/instances', payload),
  update: (id, patch) => request('PATCH', `/instances/${id}`, patch),
  remove: (id) => request('DELETE', `/instances/${id}`),

  // lifecycle
  start: (id) => request('POST', `/instances/${id}/start`),
  stop: (id) => request('POST', `/instances/${id}/stop`),
  restart: (id) => request('POST', `/instances/${id}/restart`),

  // per-channel enable/disable (Discord etc.) — GET lists channels + enabled state; POST toggles one
  channels: (id) => request('GET', `/instances/${id}/channels`),
  setChannel: (id, body) => request('POST', `/instances/${id}/channels`, body)
}
