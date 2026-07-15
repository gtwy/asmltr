import { ref } from 'vue'
import { update } from '@/services/api'

// Singleton (module-level) so the Settings "Update now" button and the global App panel share one
// poller. Reads /v2/update/progress (backed by a status FILE), so progress survives the mid-update
// service restart that drops the socket/event stream — during that gap the poll fails and we show
// "restarting services…" instead of vanishing.
const status = ref({ state: 'idle' })
const active = ref(false)   // is the progress panel shown?
let wasRunning = false       // only pop the panel for a run we actually observed (not a stale terminal file)
let started = false
let timer = null

const TERMINAL = ['success', 'rolled-back', 'failed', 'up-to-date', 'managed']
const isTerminal = (s) => TERMINAL.includes(s)

async function poll() {
  let s
  try {
    s = await update.progress()
  } catch (_) {
    // core is down (likely the mid-update restart) — keep the panel, show "restarting" unless we've
    // already seen a terminal result.
    if (active.value && !isTerminal(status.value.state)) status.value = { ...status.value, state: 'restarting' }
    return
  }
  status.value = s
  if (s.state === 'running' && !s.stale) { active.value = true; wasRunning = true }
  else if (isTerminal(s.state) && wasRunning) { active.value = true } // show the result after a tracked run
}

function schedule() { timer = setTimeout(async () => { await poll(); schedule() }, active.value ? 1800 : 5000) }
function ensureStarted() { if (started) return; started = true; poll(); schedule() }

// call the instant the user triggers an update, so the panel appears without waiting for a poll
function begin() { active.value = true; wasRunning = true; status.value = { state: 'running', phase: 'starting…', log: [] } }
function dismiss() { active.value = false; wasRunning = false; status.value = { state: 'idle' } }

export function useUpdateProgress() {
  ensureStarted()
  return { status, active, begin, dismiss }
}
