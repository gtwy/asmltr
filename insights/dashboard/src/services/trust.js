// REST client for the asmltr trust framework (principals, identifiers, roles,
// capability grants). The trust API lives on the CORE and serves its routes at
// the root under /trust/... (e.g. /trust/principals) — exactly like the
// collector serves /api/.... So, like api.js, there is NO prefix to strip:
//   dev:  Vite proxy /trust -> http://127.0.0.1:3023 (no rewrite, no token)
//   prod: nginx /trust/ -> host.docker.internal:3023 (X-Remote-User; optional
//         future bearer token injected server-side)
// This module never has to know about auth or host details.

async function request(method, path, body) {
  const opts = {
    method,
    headers: { Accept: 'application/json' }
  }
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }
  const res = await fetch(`/trust${path}`, opts)
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
    const msg = (data && data.error) || `${method} /trust${path} -> ${res.status} ${res.statusText}`
    throw new Error(msg)
  }
  return data
}

export const trust = {
  // principals
  principals: () => request('GET', '/principals'),
  principal: (id) => request('GET', `/principals/${encodeURIComponent(id)}`),
  createPrincipal: (payload) => request('POST', '/principals', payload),
  updatePrincipal: (id, patch) => request('PATCH', `/principals/${encodeURIComponent(id)}`, patch),
  removePrincipal: (id) => request('DELETE', `/principals/${encodeURIComponent(id)}`),
  // merge principal `id` (absorbed) INTO `into` (survivor)
  mergePrincipal: (id, into) => request('POST', `/principals/${encodeURIComponent(id)}/merge`, { into }),

  // identifiers (scoped to a principal for create, global by id for delete)
  addIdentifier: (principalId, payload) =>
    request('POST', `/principals/${encodeURIComponent(principalId)}/identifiers`, payload),
  removeIdentifier: (iid) => request('DELETE', `/identifiers/${encodeURIComponent(iid)}`),

  // roles (upsert via POST with optional id)
  roles: () => request('GET', '/roles'),
  saveRole: (payload) => request('POST', '/roles', payload),
  removeRole: (id) => request('DELETE', `/roles/${encodeURIComponent(id)}`),

  // grants (scoped to a principal for create, global by id for delete)
  addGrant: (principalId, payload) =>
    request('POST', `/principals/${encodeURIComponent(principalId)}/grants`, payload),
  removeGrant: (gid) => request('DELETE', `/grants/${encodeURIComponent(gid)}`),

  // resolve — debug "what can this person do here" preview
  resolve: (payload) => request('POST', '/resolve', payload)
}
