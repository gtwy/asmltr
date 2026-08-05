<script setup>
// Recordings library (roadmap §B4). Lists recording records from the core, plays audio, and shows the
// AI enrichment (title, summary, action items, highlights, participants) + the full transcript. Upload
// audio to create a recording; it transcribes + enriches in the background and the list polls until done.
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { recordingsApi } from '@/services/api'

const items = ref([])
const selectedId = ref(null)
const detail = ref(null)
const error = ref(null)
const loading = ref(false)
const uploading = ref(false)
const showTranscript = ref(false)
const fileInput = ref(null)
let poll = null

const selected = computed(() => items.value.find((r) => r.id === selectedId.value) || null)
const anyBusy = computed(() => items.value.some((r) => r.status === 'transcribing' || r.status === 'uploaded'))

async function loadList() {
  try {
    const r = await recordingsApi.list()
    items.value = r.recordings || []
    if (!selectedId.value && items.value.length) select(items.value[0].id)
    else if (selectedId.value && detail.value && detail.value.status !== fresh(selectedId.value)?.status) loadDetail(selectedId.value)
  } catch (e) { error.value = e.message }
}
function fresh(id) { return items.value.find((r) => r.id === id) }

async function loadDetail(id) {
  try { detail.value = await recordingsApi.get(id) } catch (e) { error.value = e.message }
}
function select(id) { selectedId.value = id; detail.value = null; showTranscript.value = false; loadDetail(id) }

async function onPick(ev) {
  const file = ev.target.files && ev.target.files[0]
  if (!file) return
  uploading.value = true; error.value = null
  try {
    const r = await recordingsApi.upload(file, { source: 'dashboard', title: file.name.replace(/\.[^.]+$/, '') })
    await loadList(); if (r.id) select(r.id)
  } catch (e) { error.value = e.message } finally { uploading.value = false; if (fileInput.value) fileInput.value.value = '' }
}

async function reEnrich() {
  if (!selected.value) return
  loading.value = true
  try { await recordingsApi.enrich(selected.value.id); await loadList(); await loadDetail(selected.value.id) }
  catch (e) { error.value = e.message } finally { loading.value = false }
}
async function remove(id) {
  if (!confirm('Delete this recording?')) return
  try { await recordingsApi.remove(id); if (selectedId.value === id) { selectedId.value = null; detail.value = null } await loadList() }
  catch (e) { error.value = e.message }
}

function fmtDate(s) { if (!s) return ''; const d = new Date(s); return isNaN(d) ? s : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }
function fmtDur(sec) { if (!sec) return ''; const m = Math.floor(sec / 60), s = Math.round(sec % 60); return m ? `${m}m ${s}s` : `${s}s` }
const STATUS = {
  uploaded: ['Uploaded', 'text-slate-400 bg-white/5'],
  transcribing: ['Transcribing…', 'text-amber-300 bg-amber-500/10'],
  transcribed: ['Transcribed', 'text-sky-300 bg-sky-500/10'],
  enriched: ['Ready', 'text-emerald-300 bg-emerald-500/10'],
  error: ['Error', 'text-rose-300 bg-rose-500/10']
}
function badge(s) { return STATUS[s] || [s, 'text-slate-400 bg-white/5'] }

onMounted(() => { loadList(); poll = setInterval(() => { if (anyBusy.value) loadList() }, 4000) })
onBeforeUnmount(() => clearInterval(poll))
</script>

<template>
  <div class="p-4 md:p-6 max-w-6xl mx-auto">
    <div class="flex items-center justify-between gap-3 mb-4">
      <div>
        <h1 class="text-xl font-bold">Recordings</h1>
        <p class="text-sm text-slate-400">Meetings & voice notes — transcribed and summarized.</p>
      </div>
      <button class="md-tap px-3 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
              :style="{ background: 'linear-gradient(120deg, rgb(var(--brand-violet)), rgb(var(--brand-pink)))' }"
              :disabled="uploading" @click="fileInput.click()">
        {{ uploading ? 'Uploading…' : '＋ Upload audio' }}
      </button>
      <input ref="fileInput" type="file" accept="audio/*,video/*" class="hidden" @change="onPick" />
    </div>

    <p v-if="error" class="mb-3 text-sm text-rose-300 bg-rose-500/10 rounded-lg px-3 py-2">{{ error }}</p>

    <div class="grid md:grid-cols-[minmax(0,20rem)_1fr] gap-4">
      <!-- list -->
      <div class="flex flex-col gap-2">
        <p v-if="!items.length" class="text-sm text-slate-500 px-1">No recordings yet. Upload an audio file to start.</p>
        <button v-for="r in items" :key="r.id" @click="select(r.id)"
                class="text-left rounded-xl px-3 py-2.5 border transition"
                :class="r.id === selectedId ? 'bg-white/10 border-white/20' : 'bg-white/[0.03] border-white/10 hover:bg-white/[0.06]'">
          <div class="flex items-center justify-between gap-2">
            <span class="font-medium text-sm truncate">{{ r.title || 'Untitled recording' }}</span>
            <span class="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full" :class="badge(r.status)[1]">{{ badge(r.status)[0] }}</span>
          </div>
          <div class="text-[11px] text-slate-500 mt-0.5">{{ fmtDate(r.created) }}<span v-if="r.duration_sec"> · {{ fmtDur(r.duration_sec) }}</span></div>
        </button>
      </div>

      <!-- detail -->
      <div v-if="detail" class="rounded-2xl border border-white/10 bg-white/[0.03] p-4 md:p-5 min-w-0">
        <div class="flex items-start justify-between gap-3">
          <h2 class="text-lg font-semibold">{{ detail.title || 'Untitled recording' }}</h2>
          <div class="flex items-center gap-2 shrink-0">
            <button class="text-xs px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 disabled:opacity-50"
                    :disabled="loading || !detail.has_transcript" @click="reEnrich">Re-summarize</button>
            <button class="text-xs px-2 py-1 rounded-lg text-rose-300 bg-rose-500/10 hover:bg-rose-500/20" @click="remove(detail.id)">Delete</button>
          </div>
        </div>
        <div class="text-[11px] text-slate-500 mt-0.5 mb-3">
          {{ fmtDate(detail.created) }}<span v-if="detail.duration_sec"> · {{ fmtDur(detail.duration_sec) }}</span> · {{ badge(detail.status)[0] }}
        </div>

        <audio :src="recordingsApi.audioUrl(detail.id)" controls preload="none" class="w-full mb-4 h-9"></audio>

        <p v-if="detail.status === 'transcribing'" class="text-sm text-amber-300">Transcribing… this can take a minute for a long recording.</p>
        <p v-else-if="detail.status === 'error'" class="text-sm text-rose-300">Failed: {{ detail.error }}</p>

        <div v-if="detail.people && detail.people.length" class="mb-3 flex flex-wrap gap-1.5">
          <span v-for="(p, i) in detail.people" :key="i" class="text-xs px-2 py-0.5 rounded-full bg-white/5 text-slate-300">{{ p.name }}</span>
        </div>

        <div v-if="detail.description" class="mb-4">
          <h3 class="text-xs uppercase tracking-wide text-slate-500 mb-1">Summary</h3>
          <p class="text-sm text-slate-200 whitespace-pre-wrap leading-relaxed">{{ detail.description }}</p>
        </div>

        <div v-if="detail.action_items && detail.action_items.length" class="mb-4">
          <h3 class="text-xs uppercase tracking-wide text-slate-500 mb-1">Action items</h3>
          <ul class="space-y-1">
            <li v-for="(a, i) in detail.action_items" :key="i" class="text-sm text-slate-200 flex gap-2"><span class="text-brand">☐</span><span>{{ a }}</span></li>
          </ul>
        </div>

        <div v-if="detail.highlights && detail.highlights.length" class="mb-4">
          <h3 class="text-xs uppercase tracking-wide text-slate-500 mb-1">Highlights</h3>
          <ul class="space-y-1 list-disc pl-5">
            <li v-for="(h, i) in detail.highlights" :key="i" class="text-sm text-slate-300">{{ h }}</li>
          </ul>
        </div>

        <div v-if="detail.transcript">
          <button class="text-xs px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 mb-2" @click="showTranscript = !showTranscript">
            {{ showTranscript ? 'Hide' : 'Show' }} full transcript ({{ Math.round((detail.transcript || '').length / 1000) }}k chars)
          </button>
          <pre v-if="showTranscript" class="text-[13px] text-slate-300 whitespace-pre-wrap leading-relaxed max-h-[28rem] overflow-auto bg-black/20 rounded-lg p-3">{{ detail.transcript }}</pre>
        </div>
      </div>
      <div v-else class="rounded-2xl border border-white/10 bg-white/[0.03] p-8 text-center text-slate-500 text-sm">
        Select a recording.
      </div>
    </div>
  </div>
</template>

<style scoped>
.text-brand { color: rgb(var(--brand-violet)); }
</style>
