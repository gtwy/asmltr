<script setup>
// Unified "manage session" pane. One chat interface over every session type:
//  • web sessions (session_id `web:…`) — the BROWSER is the connector: the composer
//    streams a turn through the core (/v2/stream) and renders the reply live.
//  • channel sessions (discord/email/…) — the composer DIRECTS the conversation by
//    injecting an operator message; the reply routes back to the origin channel.
//  • interactive `asmltr claude` (tmux) — the composer types into the pane (send-keys).
// History is seeded from the collector then live-appended from the socket, and rendered
// as a chat transcript (user / assistant bubbles + collapsible activity).
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useCollectorStore } from '@/stores/collector'
import { api, control, webChat, parsePayload } from '@/services/api'
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

const store = useCollectorStore()
const key = computed(() => props.session.session_id)
const st = computed(() => statusMeta(props.session.status))

// session type ---------------------------------------------------------------
const isWeb = computed(() => String(key.value || '').startsWith('web:'))
const isCli = computed(() => props.session.multiplexer === 'tmux')
const isChannel = computed(() => !isWeb.value && !isCli.value)
const attachCmd = computed(() => (isCli.value && props.session.tmux_target ? `tmux attach -t ${props.session.tmux_target}` : null))

const isDiscordChannel = computed(() => {
  const p = String(key.value || '').split(':')
  return p[0] === 'discord' && p[2] === 'channel'
})
const monitored = computed(() => props.channelState !== false)

// One-click copy of the session id (hand it to `asmltr context <id>`).
const copied = ref(false)
function copyId() {
  const id = key.value
  const done = () => { copied.value = true; setTimeout(() => (copied.value = false), 1200) }
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(id).then(done).catch(done)
  else { try { const t = document.createElement('textarea'); t.value = id; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); done() } catch (_) {} }
}

// ---- history ----------------------------------------------------------------
const seeded = ref([]) // chronological (oldest → newest), fetched once on open
const loading = ref(true)
const scrollBox = ref(null)

const maxSeededTs = computed(() => (seeded.value.length ? seeded.value[seeded.value.length - 1].ts : 0))
// When we start chatting locally in a WEB session, freeze the recorded history at that point and
// render subsequent turns from `localTurns` (the core also records them, so this avoids doubles).
const cutoffTs = ref(null)
const history = computed(() => {
  const live = store.events
    .filter((e) => e.session_id === key.value && e.ts > maxSeededTs.value)
    .slice().reverse()
  let all = [...seeded.value, ...live]
  if (cutoffTs.value != null) all = all.filter((e) => e.ts <= cutoffTs.value)
  return all
})

async function load() {
  loading.value = true
  try {
    const data = await api.events({ session: key.value, limit: 300 })
    seeded.value = (data.events || []).map((e) => ({ ...e, _payload: parsePayload(e.payload) })).reverse()
  } catch (e) { seeded.value = [] }
  finally { loading.value = false; scrollToBottom() }
}

function scrollToBottom() {
  nextTick(() => { const el = scrollBox.value; if (el) el.scrollTop = el.scrollHeight })
}
onMounted(load)

// ---- chat rows (events → transcript) ----------------------------------------
function stringify(v) { if (v == null) return ''; return typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v) }
function eventRow(e) {
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
// The live local turns (web sessions): each renders a user bubble + a streaming assistant bubble.
const localTurns = ref([]) // { user, reply, tools:[], streaming, error, ts }
const rows = computed(() => {
  const out = history.value.map(eventRow)
  for (const t of localTurns.value) {
    out.push({ kind: 'user', text: t.user, ts: t.ts })
    if (t.tools?.length) out.push({ kind: 'activity', icon: '🔧', label: `using ${t.tools.join(', ')}`, text: '', ts: t.ts + 1 })
    out.push({ kind: 'assistant', text: t.reply, streaming: t.streaming, error: t.error, ts: t.ts + 2 })
  }
  return out
})
watch(() => rows.value.length, scrollToBottom)
watch(() => localTurns.value.map((t) => t.reply.length + (t.streaming ? 1 : 0)).join(','), scrollToBottom)

// expand/collapse long activity payloads
const expanded = ref({})
function toggleExpand(i) { expanded.value = { ...expanded.value, [i]: !expanded.value[i] } }

// ---- composer ---------------------------------------------------------------
const draft = ref('')
const busy = ref(false)
const notice = ref(null)   // { ok, text }
const attached = ref([])   // web file attachments: { path, name, mime, kind }
const uploading = ref(false)
const fileInput = ref(null)
let streamCtrl = null

function pickFile() { fileInput.value?.click() }
async function onFile(ev) {
  const files = Array.from(ev.target.files || [])
  ev.target.value = ''
  for (const f of files) {
    uploading.value = true
    try { const r = await webChat.upload(f, key.value); if (r.ok) attached.value = [...attached.value, r.file] }
    catch (e) { notice.value = { ok: false, text: `upload failed: ${e.message}` } }
    finally { uploading.value = false }
  }
}
function removeAttachment(i) { attached.value = attached.value.filter((_, j) => j !== i) }

function webSend() {
  const text = draft.value.trim()
  if (!text && !attached.value.length) return
  if (cutoffTs.value == null) cutoffTs.value = Math.max(maxSeededTs.value, ...store.events.filter((e) => e.session_id === key.value).map((e) => e.ts), 0)
  const files = attached.value.slice()
  let body = text
  if (files.length) body += '\n\n' + files.map((f) => `[Attached file: ${f.name} → ${f.path}]`).join('\n')
  const turn = { user: text + (files.length ? `\n📎 ${files.map((f) => f.name).join(', ')}` : ''), reply: '', tools: [], streaming: true, error: null, ts: Date.now() }
  localTurns.value = [...localTurns.value, turn]
  draft.value = ''; attached.value = []; notice.value = null; busy.value = true
  streamCtrl = webChat.send(
    { conversation_key: key.value, text: body, attachments: files.map((f) => ({ type: f.kind === 'image' ? 'image' : 'file', path: f.path, name: f.name, media_type: f.mime })), working_dir: props.session.working_dir || null },
    {
      onDelta: (t) => { turn.reply += t },
      onTool: (name) => { if (name && !turn.tools.includes(name)) turn.tools = [...turn.tools, name] },
      onSegment: (t) => { if (!turn.reply && t) turn.reply = t }, // fallback if no deltas came
      onDone: () => { turn.streaming = false; busy.value = false; streamCtrl = null; store.fetchSessions() },
      onError: (err) => { turn.streaming = false; turn.error = err; busy.value = false; streamCtrl = null }
    }
  )
}

async function doInject() {
  const text = draft.value.trim()
  if (!text) return
  busy.value = true; notice.value = null
  try {
    if (isCli.value) {
      await control.sendText(key.value, text); draft.value = ''
      notice.value = { ok: true, text: 'Typed into the session + pressed Enter.' }
    } else {
      const r = await control.inject(key.value, text)
      if (r.ok) { draft.value = ''; notice.value = { ok: true, text: `Directed — ${r.delivered ? 'reply sent to the channel' : (r.deliverErr ? `reply not delivered: ${r.deliverErr}` : 'no channel delivery')}.` } }
      else notice.value = { ok: false, text: r.error || 'inject failed' }
    }
  } catch (e) { notice.value = { ok: false, text: e.message } }
  finally { busy.value = false }
}

function onSend() { return isWeb.value ? webSend() : doInject() }

async function onStop() {
  if (isWeb.value) {
    try { streamCtrl?.abort() } catch (_) {}
    try { await control.abort(key.value) } catch (_) {}
    const t = localTurns.value[localTurns.value.length - 1]
    if (t && t.streaming) { t.streaming = false; t.error = t.error || 'stopped' }
    busy.value = false
    notice.value = { ok: true, text: 'Stopped the in-flight turn.' }
    return
  }
  busy.value = true; notice.value = null
  try {
    if (isCli.value) { await control.sendKey(key.value, 'Escape'); notice.value = { ok: true, text: 'Sent an interrupt (Escape) to the session.' } }
    else { const r = await control.abort(key.value); notice.value = { ok: !!r.ok, text: r.ok ? 'Stopped the in-flight turn (session still resumable).' : (r.error || 'nothing in flight') } }
  } catch (e) { notice.value = { ok: false, text: e.message } }
  finally { busy.value = false }
}

onBeforeUnmount(() => { try { streamCtrl?.abort() } catch (_) {} })

const placeholder = computed(() => {
  if (isWeb.value) return 'Message this session… (Enter to send, Shift+Enter for a newline)'
  if (isCli.value) return 'Type a message to send into the terminal session (Enter)…'
  return 'Type a message to direct this conversation, then Send (reply goes back to the channel)…'
})
</script>

<template>
  <ModalShell
    wide
    :title="session.title || session.identity || (isWeb ? 'Web session' : 'Conversation')"
    :subtitle="key"
    @close="$emit('close')"
  >
    <!-- meta strip -->
    <div class="mb-3 flex flex-wrap items-center gap-2 text-[11px]">
      <SurfaceBadge :surface="session.surface" />
      <span v-if="session.working_dir" class="pill border border-white/10 bg-white/5 font-mono text-slate-400" :title="'working dir: ' + session.working_dir">📂 {{ truncate(session.working_dir, 34) }}</span>
      <span v-if="session.location" class="pill border border-white/10 bg-white/5 text-slate-300" :title="'origin: ' + session.location">💬 {{ session.location }}</span>
      <span v-if="session.kind" class="pill border border-white/10 bg-white/5 text-slate-300">{{ session.kind }}</span>
      <span class="flex items-center gap-1.5" :style="{ color: st.color }">
        <span class="h-2 w-2 rounded-full" :class="st.pulse ? 'animate-pulse-dot' : ''" :style="{ backgroundColor: st.color }"></span>
        {{ st.label }}
      </span>
      <span v-if="session.tokens_total" class="pill border border-violet-400/30 bg-violet-400/10 text-violet-300">⟁ {{ fmtNum(session.tokens_total) }} tok</span>
      <span v-if="session.tool_count" class="pill border border-amber-400/30 bg-amber-400/10 text-amber-300">🛠 {{ fmtNum(session.tool_count) }}</span>
      <span v-if="session.last_activity_unix" class="text-slate-500">last {{ fmtAge(session.last_activity_unix, now) }}</span>
      <button
        v-if="isDiscordChannel"
        type="button"
        :disabled="channelBusy"
        :title="monitored ? 'Monitoring this channel — click to disable (bot stops responding here)' : 'Channel disabled — click to re-enable monitoring'"
        class="pill border transition-colors disabled:opacity-40"
        :class="monitored ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300 hover:bg-emerald-400/20' : 'border-white/10 bg-white/5 text-slate-400 hover:text-slate-200'"
        @click="$emit('toggle-channel', key)"
      >{{ channelBusy ? '…' : (monitored ? '● monitored' : '○ disabled') }}</button>
      <button
        type="button"
        class="pill border border-white/10 bg-white/5 text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-200"
        :title="copied ? 'Copied!' : 'Copy session id — hand it to `asmltr context <id>`'"
        @click="copyId"
      >{{ copied ? '✓ copied' : '⧉ copy id' }}</button>
    </div>

    <!-- transcript -->
    <div ref="scrollBox" class="max-h-[52vh] space-y-2.5 overflow-y-auto rounded-xl border border-white/5 bg-black/20 p-3">
      <p v-if="loading" class="py-6 text-center text-sm text-slate-500">loading history…</p>
      <p v-else-if="!rows.length" class="py-8 text-center text-sm text-slate-500">
        {{ isWeb ? 'New session — send a message below to begin.' : 'No events recorded for this session yet.' }}
      </p>
      <template v-for="(r, i) in rows" :key="i">
        <!-- user bubble (right) -->
        <div v-if="r.kind === 'user'" class="flex justify-end">
          <div class="max-w-[82%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm border border-brand-violet/30 bg-brand-violet/15 px-3 py-2 text-[13px] leading-snug text-violet-100">{{ r.text }}</div>
        </div>
        <!-- assistant bubble (left) -->
        <div v-else-if="r.kind === 'assistant'" class="flex justify-start">
          <div class="max-w-[82%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-sm border border-white/10 bg-white/[0.05] px-3 py-2 text-[13px] leading-snug"
               :class="r.error ? 'text-rose-300' : 'text-slate-100'">
            <span>{{ r.text }}</span>
            <span v-if="r.streaming" class="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse-dot rounded-sm bg-brand-violet/80 align-middle"></span>
            <span v-if="r.streaming && !r.text" class="text-slate-500">thinking…</span>
            <span v-if="r.error" class="block text-[11px] text-rose-400/80">⚠ {{ r.error }}</span>
          </div>
        </div>
        <!-- activity line (thinking / tool / result / control) -->
        <div v-else class="flex items-start gap-1.5 pl-1 text-[11px] text-slate-500">
          <span class="shrink-0 select-none opacity-80">{{ r.icon }}</span>
          <span class="shrink-0 font-semibold uppercase tracking-wide text-slate-500/90">{{ r.label }}</span>
          <span
            v-if="r.text"
            class="min-w-0 cursor-pointer break-words"
            :class="[r.mono ? 'font-mono' : '', r.err ? 'text-rose-400/80' : 'text-slate-500', expanded[i] ? 'whitespace-pre-wrap' : 'truncate']"
            :title="expanded[i] ? 'click to collapse' : 'click to expand'"
            @click="toggleExpand(i)"
          >{{ expanded[i] ? truncate(r.text, 6000) : truncate(r.text, 140) }}</span>
        </div>
      </template>
    </div>

    <template #footer>
      <div class="w-full">
        <div v-if="attachCmd" class="mb-2 flex items-center gap-2 text-[11px] text-slate-400">
          <span>Take over in your terminal (detach from the channel):</span>
          <code class="rounded bg-black/40 px-1.5 py-0.5 font-mono text-brand-violet/90">{{ attachCmd }}</code>
        </div>
        <div v-if="notice" class="mb-2 text-xs" :class="notice.ok ? 'text-emerald-300' : 'text-rose-300'">{{ notice.text }}</div>

        <!-- attachment chips (web) -->
        <div v-if="attached.length || uploading" class="mb-2 flex flex-wrap items-center gap-1.5">
          <span v-for="(a, i) in attached" :key="a.path" class="pill flex items-center gap-1 border border-white/10 bg-white/5 text-slate-300">
            📎 {{ truncate(a.name, 26) }}
            <button type="button" class="text-slate-500 hover:text-rose-300" title="remove" @click="removeAttachment(i)">✕</button>
          </span>
          <span v-if="uploading" class="text-[11px] text-slate-500">uploading…</span>
        </div>

        <div class="flex items-end gap-2">
          <button
            type="button"
            :disabled="busy && !isWeb"
            :title="isCli ? 'Send an interrupt (Escape) to the session' : 'Abort the in-flight turn — the session survives and stays resumable'"
            class="shrink-0 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs font-semibold text-rose-300 transition-colors hover:bg-rose-500/20 disabled:opacity-40"
            @click="onStop"
          >{{ isCli ? '⎋ Interrupt' : '⏹ Stop' }}</button>

          <button
            v-if="isWeb"
            type="button"
            :disabled="uploading"
            title="Attach a file — it's saved to the shared upload area and referenced in your message so the agent can read it"
            class="shrink-0 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-semibold text-slate-300 transition-colors hover:bg-white/10 disabled:opacity-40"
            @click="pickFile"
          >📎</button>
          <input ref="fileInput" type="file" multiple class="hidden" @change="onFile" />

          <textarea
            v-model="draft"
            rows="1"
            :placeholder="placeholder"
            class="min-h-[38px] flex-1 resize-y rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-brand-violet/60 focus:bg-white/[0.06]"
            @keydown.enter.exact.prevent="onSend"
          ></textarea>
          <button
            type="button"
            :disabled="busy || (!draft.trim() && !attached.length)"
            class="shrink-0 rounded-lg bg-brand-gradient px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-brand-violet/30 transition-opacity disabled:opacity-40"
            @click="onSend"
          >{{ busy ? '…' : 'Send' }}</button>
        </div>
      </div>
    </template>
  </ModalShell>
</template>
