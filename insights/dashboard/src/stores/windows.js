// Tiny floating-window manager. A singleton reactive list of open windows so the dashboard can have
// MANY chat popups at once (session chats + the observer), each independently focusable, minimizable,
// and closable. Windows are rendered once, globally, by <WindowHost>; any view just calls open*().
import { reactive, computed } from 'vue'

let _z = 100
const state = reactive({ list: [] }) // { id, kind: 'session'|'observer', payload, z, minimized }

function find(id) { return state.list.find((w) => w.id === id) }

function focus(id) { const w = find(id); if (w) { w.z = ++_z; w.minimized = false } }
function open({ id, kind, payload }) {
  const w = find(id)
  if (w) { if (payload) w.payload = payload; focus(id); return id } // already open → surface it
  state.list.push({ id, kind, payload, z: ++_z, minimized: false })
  return id
}
function close(id) { const i = state.list.findIndex((w) => w.id === id); if (i >= 0) state.list.splice(i, 1) }
function minimize(id) { const w = find(id); if (w) w.minimized = true }

// dedup helpers — same session/observer never opens twice, just re-focuses
function openSession(session) { return open({ id: `session:${session.session_id}`, kind: 'session', payload: { ...session } }) }
function openObserver() { return open({ id: 'observer', kind: 'observer', payload: {} }) }

// the frontmost visible window — drives Esc-to-close + the "focused" ring
const topId = computed(() => {
  const vis = state.list.filter((w) => !w.minimized)
  return vis.length ? vis.reduce((a, b) => (a.z > b.z ? a : b)).id : null
})
const minimized = computed(() => state.list.filter((w) => w.minimized))

export function useWindows() {
  return { state, open, close, focus, minimize, openSession, openObserver, topId, minimized }
}
