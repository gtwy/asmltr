<script setup>
// Live "conversation details" pane for one session: full inbound/thinking/tool/
// tool_result/outbound history (seeded from the collector, then live-appended from
// the socket), plus a takeover footer — Stop the in-flight turn, or inject an
// operator message (the reply routes back to the origin channel via the core).
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { useCollectorStore } from '@/stores/collector'
import { api, control, parsePayload } from '@/services/api'
import { surfaceMeta, statusMeta, fmtTime, fmtAge, fmtNum, truncate } from '@/lib/format'
import ModalShell from './ModalShell.vue'
import SurfaceBadge from './SurfaceBadge.vue'

const props = defineProps({
  session: { type: Object, required: true },
  now: { type: Number, default: () => Date.now() },
  channelState: { type: Boolean, default: undefined },
  channelBusy: { type: Boolean, default: false }
})
defineEmits(['close', 'toggle-channel'])

const isDiscordChannel = computed(() => {
  const p = String(props.session.session_id || '').split(':')
  return p[0] === 'discord' && p[2] === 'channel'
})
const monitored = computed(() => props.channelState !== false)

const store = useCollectorStore()
const seeded = ref([]) // chronological (oldest → newest), fetched once on open
const loading = ref(true)
const scrollBox = ref(null)

const key = computed(() => props.session.session_id)
const st = computed(() => statusMeta(props.session.status))

// One-click copy of the session id (hand it to `asmltr context <id>` to pull this session's context).
const copied = ref(false)
function copyId() {
  const id = props.session.session_id
  const done = () => { copied.value = true; setTimeout(() => (copied.value = false), 1200) }
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(id).then(done).catch(done)
  else { try { const t = document.createElement('textarea'); t.value = id; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); done() } catch (_) {} }
}

// Merge the seeded history with any newer live events for THIS session that have
// streamed into the store since we fetched (store.events is newest-first).
const maxSeededTs = computed(() => (seeded.value.length ? seeded.value[seeded.value.length - 1].ts : 0))
const history = computed(() => {
  const live = store.events
    .filter((e) => e.session_id === key.value && e.ts > maxSeededTs.value)
    .slice()
    .reverse() // → chronological
  return [...seeded.value, ...live]
})

async function load() {
  loading.value = true
  try {
    const data = await api.events({ session: key.value, limit: 300 })
    seeded.value = (data.events || [])
      .map((e) => ({ ...e, _payload: parsePayload(e.payload) }))
      .reverse() // API is newest-first → make chronological
  } catch (e) {
    seeded.value = []
  } finally {
    loading.value = false
    scrollToBottom()
  }
}

function scrollToBottom() {
  nextTick(() => {
    const el = scrollBox.value
    if (el) el.scrollTop = el.scrollHeight
  })
}
watch(() => history.value.length, scrollToBottom)
onMounted(load)

// ---- per-event display shape -------------------------------------------------
function stringify(v) {
  if (v == null) return ''
  return typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v)
}
function view(e) {
  const p = e._payload || parsePayload(e.payload) || {}
  switch (e.event_type) {
    case 'inbound': return { icon: '▶', role: 'in', color: '#60A5FA', text: p.text }
    case 'outbound': return { icon: '◀', role: 'reply', color: '#34D399', text: p.text || (p.chars != null ? `(${p.chars} chars)` : '') }
    case 'thinking': return { icon: '💭', role: 'thinking', color: '#94A3B8', text: p.text, dim: true }
    case 'tool': return { icon: '🔧', role: `tool · ${p.tool || ''}`.trim(), color: '#FBBF24', text: stringify(p.input), mono: true }
    case 'tool_result': return { icon: p.is_error ? '⚠' : '📥', role: p.is_error ? 'error' : 'result', color: p.is_error ? '#F87171' : '#22D3EE', text: stringify(p.output), mono: true }
    case 'moderation_decision': return { icon: '🛡', role: `moderation · ${p.decision || ''}`.trim(), color: '#F87171', text: p.riskLevel != null ? `risk ${p.riskLevel}` : (p.reason || '') }
    case 'control': return { icon: '⚙', role: `control · ${p.action || ''}`.trim(), color: '#A78BFA', text: p.by ? `by ${p.by}` : '' }
    case 'token-usage': return { icon: '∑', role: 'tokens', color: '#A78BFA', text: `${fmtNum(e.tokens_in)}→${fmtNum(e.tokens_out)}${p.tools != null ? ` · ${p.tools} tools` : ''}`, dim: true }
    case 'session-start': return { icon: '●', role: 'session start', color: '#4ADE80', text: '', dim: true }
    default: return { icon: '·', role: e.event_type, color: '#94A3B8', text: p.text || p.decision || p.action || '' }
  }
}

// ---- takeover ---------------------------------------------------------------
// Two flavours: SDK/channel sessions steer via the core (/v2), while interactive
// `asmltr claude` tmux sessions are driven by sending keys to their pane.
const isCli = computed(() => props.session.multiplexer === 'tmux')
const attachCmd = computed(() => (isCli.value && props.session.tmux_target ? `tmux attach -t ${props.session.tmux_target}` : null))
const steer = ref('')
const busy = ref(false)
const notice = ref(null) // { ok, text }
async function doAbort() {
  busy.value = true; notice.value = null
  try {
    if (isCli.value) {
      await control.sendKey(key.value, 'Escape')
      notice.value = { ok: true, text: 'Sent an interrupt (Escape) to the session.' }
    } else {
      const r = await control.abort(key.value)
      notice.value = { ok: !!r.ok, text: r.ok ? 'Stopped the in-flight turn (session still resumable).' : (r.error || 'nothing in flight') }
    }
  } catch (e) { notice.value = { ok: false, text: e.message } }
  finally { busy.value = false }
}
async function doInject() {
  const text = steer.value.trim()
  if (!text) return
  busy.value = true; notice.value = null
  try {
    if (isCli.value) {
      await control.sendText(key.value, text)
      steer.value = ''
      notice.value = { ok: true, text: 'Typed into the session + pressed Enter.' }
    } else {
      const r = await control.inject(key.value, text)
      if (r.ok) {
        steer.value = ''
        notice.value = { ok: true, text: `Steered${r.delivered ? ' — reply sent to the channel' : (r.deliverErr ? ` (reply not delivered: ${r.deliverErr})` : '')}.` }
      } else notice.value = { ok: false, text: r.error || 'inject failed' }
    }
  } catch (e) { notice.value = { ok: false, text: e.message } }
  finally { busy.value = false }
}
</script>

<template>
  <ModalShell
    wide
    :title="session.identity || 'Conversation'"
    :subtitle="session.session_id"
    @close="$emit('close')"
  >
    <!-- meta strip -->
    <div class="mb-3 flex flex-wrap items-center gap-2 text-[11px]">
      <SurfaceBadge :surface="session.surface" />
      <span v-if="session.location" class="pill border border-white/10 bg-white/5 text-slate-300" :title="'origin: ' + session.location">💬 {{ session.location }}</span>
      <span class="pill border border-white/10 bg-white/5 text-slate-300">{{ session.kind }}</span>
      <span class="flex items-center gap-1.5" :style="{ color: st.color }">
        <span class="h-2 w-2 rounded-full" :class="st.pulse ? 'animate-pulse-dot' : ''" :style="{ backgroundColor: st.color }"></span>
        {{ st.label }}
      </span>
      <span class="pill border border-violet-400/30 bg-violet-400/10 text-violet-300">⟁ {{ fmtNum(session.tokens_total) }} tok</span>
      <span v-if="session.tool_count" class="pill border border-amber-400/30 bg-amber-400/10 text-amber-300">🛠 {{ fmtNum(session.tool_count) }}</span>
      <span class="text-slate-500">last {{ fmtAge(session.last_activity_unix, now) }}</span>
      <button
        v-if="isDiscordChannel"
        type="button"
        :disabled="channelBusy"
        :title="monitored ? 'Monitoring this channel — click to disable (bot stops responding here)' : 'Channel disabled — click to re-enable monitoring'"
        class="pill border transition-colors disabled:opacity-40"
        :class="monitored ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300 hover:bg-emerald-400/20' : 'border-white/10 bg-white/5 text-slate-400 hover:text-slate-200'"
        @click="$emit('toggle-channel', session.session_id)"
      >{{ channelBusy ? '…' : (monitored ? '● monitored' : '○ disabled') }}</button>
      <button
        type="button"
        class="pill border border-white/10 bg-white/5 text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-200"
        :title="copied ? 'Copied!' : 'Copy session id — hand it to `asmltr context <id>`'"
        @click="copyId"
      >{{ copied ? '✓ copied' : '⧉ copy id' }}</button>
    </div>

    <!-- conversation history -->
    <div ref="scrollBox" class="max-h-[52vh] space-y-2 overflow-y-auto rounded-xl border border-white/5 bg-black/20 p-3">
      <p v-if="loading" class="py-6 text-center text-sm text-slate-500">loading history…</p>
      <p v-else-if="!history.length" class="py-6 text-center text-sm text-slate-500">No events recorded for this session yet.</p>
      <div v-for="(e, i) in history" :key="e.ts + ':' + i" class="flex gap-2">
        <div class="mt-0.5 shrink-0 select-none text-sm" :style="{ color: view(e).color }">{{ view(e).icon }}</div>
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-2">
            <span class="text-[11px] font-semibold uppercase tracking-wide" :style="{ color: view(e).color }">{{ view(e).role }}</span>
            <span class="font-mono text-[10px] tabular-nums text-slate-600">{{ fmtTime(e.ts) }}</span>
          </div>
          <div
            v-if="view(e).text"
            class="mt-0.5 whitespace-pre-wrap break-words text-[13px] leading-snug"
            :class="[view(e).dim ? 'text-slate-500' : 'text-slate-200', view(e).mono ? 'font-mono text-[12px]' : '']"
          >{{ truncate(view(e).text, 4000) }}</div>
        </div>
      </div>
    </div>

    <!-- direct the session (stop a turn / send a message). NOT "takeover" — that's the terminal detach below. -->
    <template #footer>
      <div class="w-full">
        <div v-if="attachCmd" class="mb-2 flex items-center gap-2 text-[11px] text-slate-400">
          <span>Take over in your terminal (detach from the channel):</span>
          <code class="rounded bg-black/40 px-1.5 py-0.5 font-mono text-brand-violet/90">{{ attachCmd }}</code>
        </div>
        <div v-if="notice" class="mb-2 text-xs" :class="notice.ok ? 'text-emerald-300' : 'text-rose-300'">{{ notice.text }}</div>
        <div class="flex items-end gap-2">
          <button
            type="button"
            :disabled="busy"
            :title="isCli ? 'Send an interrupt (Escape) to the session' : 'Abort the in-flight turn — the session survives and stays resumable'"
            class="shrink-0 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs font-semibold text-rose-300 transition-colors hover:bg-rose-500/20 disabled:opacity-40"
            @click="doAbort"
          >{{ isCli ? '⎋ Interrupt' : '⏹ Stop' }}</button>
          <textarea
            v-model="steer"
            rows="1"
            :placeholder="isCli ? 'Type a message to send into the session (Enter)…' : 'Type a message to direct this conversation, then Send (reply goes back to the channel)…'"
            class="min-h-[38px] flex-1 resize-y rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-brand-violet/60 focus:bg-white/[0.06]"
            @keydown.enter.exact.prevent="doInject"
          ></textarea>
          <button
            type="button"
            :disabled="busy || !steer.trim()"
            class="shrink-0 rounded-lg bg-brand-gradient px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-brand-violet/30 transition-opacity disabled:opacity-40"
            @click="doInject"
          >{{ busy ? '…' : 'Send' }}</button>
        </div>
      </div>
    </template>
  </ModalShell>
</template>
