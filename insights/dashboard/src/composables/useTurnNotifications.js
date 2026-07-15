import { ref, watch } from 'vue'

// Desktop/mobile notifications when a session turn completes — the "know when a reply is ready
// while you're away from the tab" feature (#13). Foreground: fires via the Notification API while
// the PWA/tab is open (works backgrounded on desktop; the service worker handles the click).
// Background push (app fully closed) is a follow-up that needs VAPID keys + a push subscription.
export function useTurnNotifications(store) {
  const supported = typeof window !== 'undefined' && 'Notification' in window
  const enabled = ref(false)
  try { enabled.value = localStorage.getItem('asmltr:notify') === '1' } catch (_) {}
  const permission = ref(supported ? Notification.permission : 'denied')
  // if it was enabled last session but permission was since revoked, reflect reality
  if (enabled.value && permission.value !== 'granted') enabled.value = false

  let lastTs = (store.events[0] && store.events[0].ts) || 0

  async function enable() {
    if (!supported) return
    let p = Notification.permission
    if (p === 'default') { try { p = await Notification.requestPermission() } catch (_) {} }
    permission.value = p
    enabled.value = p === 'granted'
    lastTs = (store.events[0] && store.events[0].ts) || Date.now()
    try { localStorage.setItem('asmltr:notify', enabled.value ? '1' : '0') } catch (_) {}
  }
  function disable() { enabled.value = false; try { localStorage.setItem('asmltr:notify', '0') } catch (_) {} }
  async function toggle() { if (enabled.value) disable(); else await enable() }

  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)
  function payloadOf(ev) {
    const p = ev && ev.payload
    if (!p) return {}
    if (typeof p === 'object') return p
    try { return JSON.parse(p) } catch (_) { return {} }
  }
  function fire(ev) {
    if (!supported || Notification.permission !== 'granted') return
    // Skip the dashboard's own web chats — you're already looking at those replies.
    if (ev.surface === 'eve-assistant-web') return
    const body = String(payloadOf(ev).text || '').replace(/\s+/g, ' ').slice(0, 140) || 'A session turn just completed.'
    try {
      const n = new Notification(`${cap(ev.surface || 'session')} · reply ready`, {
        body, icon: '/icons/icon-192.png', tag: 'asmltr:' + (ev.session_id || ''),
      })
      n.onclick = () => { try { window.focus() } catch (_) {} n.close() }
    } catch (_) {}
  }

  // events are newest-first; on a new head, notify for every fresh `outbound` (turn-complete) event.
  watch(() => (store.events[0] && store.events[0].ts) || 0, (ts) => {
    if (!ts) return
    if (!enabled.value || ts <= lastTs) { lastTs = Math.max(lastTs, ts); return }
    for (const ev of store.events) { if (ev.ts <= lastTs) break; if (ev.event_type === 'outbound') fire(ev) }
    lastTs = ts
  })

  return { supported, enabled, permission, toggle }
}
