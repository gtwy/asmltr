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
  updateStatus: () => get('/update-status'),
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
async function getCore(path) {
  const res = await fetch(path, { headers: { Accept: 'application/json' } })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error || `GET ${path} -> ${res.status} ${res.statusText}`)
  return json
}

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
  sendKey: (session_id, keys) => postCore('/api/control/send-keys', { session_id, keys }),
  // manually set a session title (locks it against AI regeneration); '' reverts to AI
  setTitle: (session_id, title) => postCore('/api/control/session-title', { session_id, title })
}

// Self-update on the CORE — check status (via collector), toggle auto, or run the update session.
export const update = {
  run: () => postCore('/v2/update/run', { by: 'dashboard' }),
  getAuto: () => getCore('/v2/update/auto'),
  setAuto: (enabled) => postCore('/v2/update/auto', { enabled }),
}

// Web chat — the browser acts as a connector. Post an `eve-assistant-web` envelope to the core's
// streaming endpoint and get the reply token-by-token; the core records the whole exchange, so the
// session shows up in Live like any other. The operator identity is resolved server-side (the
// dashboard never hardcodes it), so `sender` here is just a placeholder the core overwrites.
export const webChat = {
  // Stream one turn. `handlers` = { onDelta, onSegment, onTool, onThinking, onDone, onError }.
  // Returns an AbortController so the caller can cancel the fetch (the core also has /v2/abort).
  send({ conversation_key, text, attachments = [], working_dir = null }, handlers = {}) {
    const ac = new AbortController()
    const envelope = {
      channel: 'eve-assistant-web',
      conversation_key,
      sender: { raw_id: 'dashboard', raw_username: 'dashboard' },
      content: { text, attachments },
      delivery: 'sync',
      public: false,
      ...(working_dir ? { working_dir } : {})
    }
    ;(async () => {
      let res
      try {
        res = await fetch('/v2/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify(envelope),
          signal: ac.signal
        })
      } catch (e) { handlers.onError?.(e.message || 'network error'); return }
      if (!res.ok || !res.body) { handlers.onError?.(`stream ${res.status}`); return }
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          // SSE frames are separated by a blank line; each frame's payload is a `data: {...}` line.
          let idx
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const raw = buf.slice(0, idx); buf = buf.slice(idx + 2)
            const line = raw.split('\n').find((l) => l.startsWith('data:'))
            if (!line) continue
            let f; try { f = JSON.parse(line.slice(5).trim()) } catch { continue }
            if (f.type === 'delta') handlers.onDelta?.(f.text)
            else if (f.type === 'segment') handlers.onSegment?.(f.text)
            else if (f.type === 'tool') handlers.onTool?.(f.name)
            else if (f.type === 'thinking') handlers.onThinking?.(f.text)
            else if (f.type === 'done') handlers.onDone?.(f.actions || [])
            else if (f.type === 'error') handlers.onError?.(f.error || 'stream error')
          }
        }
      } catch (e) {
        if (ac.signal.aborted) handlers.onError?.('aborted')
        else handlers.onError?.(e.message || 'stream read error')
      }
    })()
    return ac
  },

  // Attach a file: base64 it and POST to the core, which stores it in the shared upload area and
  // returns the on-disk path. The next message references that path so the agent can Read it.
  async upload(file, conversation_key) {
    const data_base64 = await new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result).split(',')[1] || '')
      r.onerror = () => reject(new Error('read failed'))
      r.readAsDataURL(file)
    })
    return postCore('/v2/upload', { filename: file.name, mime: file.type, conversation_key, data_base64 })
  }
}

// Voice — the core speech layer. `speak()` streams a turn as interleaved transcript + audio-clip
// frames (chime/drone cues, an optional spoken ack, then the answer sentence-by-sentence). Same
// browser-as-connector envelope as webChat; the reply is spoken. Ack on/off persists server-side.
export const voice = {
  getAck: () => getCore('/v2/voice/ack'),
  setAck: (enabled) => postCore('/v2/voice/ack', { enabled }),
  assetUrl: (name) => `/v2/voice/asset/${name}`,
  // handlers: { onCue(name), onText({seq,text}), onAudio({seq,role,mime,b64}), onDone(actions), onError(msg) }
  speak({ conversation_key, text }, handlers = {}) {
    const ac = new AbortController()
    const envelope = {
      channel: 'eve-assistant-web', conversation_key,
      sender: { raw_id: 'dashboard', raw_username: 'dashboard' },
      content: { text }, delivery: 'sync', public: false
    }
    ;(async () => {
      let res
      try { res = await fetch('/v2/speak', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(envelope), signal: ac.signal }) }
      catch (e) { handlers.onError?.(e.message || 'network error'); return }
      if (!res.ok || !res.body) { handlers.onError?.(`speak ${res.status}`); return }
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break
          buf += dec.decode(value, { stream: true }); let i
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const raw = buf.slice(0, i); buf = buf.slice(i + 2)
            const line = raw.split('\n').find((l) => l.startsWith('data:')); if (!line) continue
            let f; try { f = JSON.parse(line.slice(5).trim()) } catch { continue }
            if (f.type === 'cue') handlers.onCue?.(f.cue)
            else if (f.type === 'text') handlers.onText?.(f)
            else if (f.type === 'audio') handlers.onAudio?.(f)
            else if (f.type === 'done') handlers.onDone?.(f.actions || [])
            else if (f.type === 'error') handlers.onError?.(f.error || 'speak error')
          }
        }
      } catch (e) { if (!ac.signal.aborted) handlers.onError?.(e.message || 'stream error') }
    })()
    return ac
  }
}

// Agent runtime — the Agent SDK version (which gates model availability), model selection, and
// SDK auto-update. Keeping the SDK current is how the underlying model stays up to date.
export const runtime = {
  get: (fetch = true) => getCore('/v2/runtime' + (fetch ? '' : '?fetch=0')),
  setModel: (model) => postCore('/v2/runtime/model', { model }),
  setAutoUpdate: (enabled) => postCore('/v2/runtime/auto-update', { enabled }),
  update: () => postCore('/v2/runtime/update', { by: 'dashboard' })
}

// Draft / approval queue on the CORE — replies any connector held for a human to approve.
export const drafts = {
  list: (status = 'pending') => getCore(`/v2/drafts?status=${encodeURIComponent(status)}`),
  approve: (id) => postCore(`/v2/drafts/${id}/approve`),
  discard: (id) => postCore(`/v2/drafts/${id}/discard`)
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
