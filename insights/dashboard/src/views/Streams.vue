<script setup>
// Streams (roadmap §A, issue #93). View all topic/project event streams, create new ones, read a
// stream's recent tail, and FTS-search (recall) within it. Streams are the shared memory sessions
// register to; here you see them, their liveness (event count · last touched · who's active), and can
// seed one yourself.
import { ref, computed, onMounted } from 'vue'
import { streamsApi } from '@/services/api'

const items = ref([])
const selectedId = ref(null)
const detail = ref(null)
const error = ref(null)
const creating = ref(false)
const newName = ref('')
const newDesc = ref('')
const query = ref('')
const results = ref(null)

const selected = computed(() => items.value.find((s) => s.id === selectedId.value) || null)

async function load() {
  try { items.value = (await streamsApi.list()).streams || []; if (!selectedId.value && items.value.length) select(items.value[0].id) }
  catch (e) { error.value = e.message }
}
async function select(id) { selectedId.value = id; results.value = null; query.value = ''; try { detail.value = await streamsApi.get(id) } catch (e) { error.value = e.message } }

async function create() {
  if (!newName.value.trim()) return
  creating.value = true; error.value = null
  try { const s = await streamsApi.create(newName.value.trim(), newDesc.value.trim()); newName.value = ''; newDesc.value = ''; await load(); if (s.id) select(s.id) }
  catch (e) { error.value = e.message } finally { creating.value = false }
}
async function recall() {
  if (!selected.value) return
  try { results.value = (await streamsApi.recall(selected.value.id, query.value.trim())).results || [] } catch (e) { error.value = e.message }
}
async function remove(id) {
  if (!confirm('Delete this stream and all its events?')) return
  try { await streamsApi.remove(id); if (selectedId.value === id) { selectedId.value = null; detail.value = null } await load() } catch (e) { error.value = e.message }
}

function fmtDate(ts) { if (!ts) return '—'; const d = new Date(ts); return isNaN(d) ? '—' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }
const shown = computed(() => results.value != null ? results.value : (detail.value?.events || []).slice().reverse())

onMounted(load)
</script>

<template>
  <div class="p-4 md:p-6 max-w-6xl mx-auto">
    <div class="mb-4">
      <h1 class="text-xl font-bold">Streams</h1>
      <p class="text-sm text-slate-400">Per-topic event streams — shared memory your sessions register to and recall from.</p>
    </div>
    <p v-if="error" class="mb-3 text-sm text-rose-300 bg-rose-500/10 rounded-lg px-3 py-2">{{ error }}</p>

    <div class="grid md:grid-cols-[minmax(0,20rem)_1fr] gap-4">
      <!-- list + create -->
      <div class="flex flex-col gap-2">
        <div class="rounded-xl border border-white/10 bg-white/[0.03] p-3 mb-1">
          <p class="text-xs uppercase tracking-wide text-slate-500 mb-2">New stream</p>
          <input v-model="newName" placeholder="name (e.g. Ops Hub)" class="w-full mb-2 px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm outline-none focus:border-white/25" />
          <input v-model="newDesc" placeholder="description (optional)" class="w-full mb-2 px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm outline-none focus:border-white/25" @keyup.enter="create" />
          <button class="w-full md-tap px-3 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50"
                  :style="{ background: 'linear-gradient(120deg, rgb(var(--brand-violet)), rgb(var(--brand-pink)))' }"
                  :disabled="creating || !newName.trim()" @click="create">{{ creating ? 'Creating…' : 'Create stream' }}</button>
        </div>
        <p v-if="!items.length" class="text-sm text-slate-500 px-1">No streams yet.</p>
        <button v-for="s in items" :key="s.id" @click="select(s.id)"
                class="text-left rounded-xl px-3 py-2.5 border transition"
                :class="s.id === selectedId ? 'bg-white/10 border-white/20' : 'bg-white/[0.03] border-white/10 hover:bg-white/[0.06]'">
          <div class="flex items-center justify-between gap-2">
            <span class="font-medium text-sm truncate">{{ s.slug }}</span>
            <span v-if="s.active_sessions?.length" class="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full text-emerald-300 bg-emerald-500/10">{{ s.active_sessions.length }} active</span>
          </div>
          <div class="text-[11px] text-slate-500 mt-0.5">{{ s.event_count }} events · last {{ fmtDate(s.last_ts) }}</div>
          <div v-if="s.description" class="text-[11px] text-slate-400 mt-0.5 truncate">{{ s.description }}</div>
        </button>
      </div>

      <!-- detail -->
      <div v-if="detail" class="rounded-2xl border border-white/10 bg-white/[0.03] p-4 md:p-5 min-w-0">
        <div class="flex items-start justify-between gap-3">
          <div>
            <h2 class="text-lg font-semibold">{{ detail.name }}</h2>
            <p class="text-[11px] text-slate-500">{{ detail.slug }} · owner {{ detail.owner }}</p>
          </div>
          <button class="text-xs px-2 py-1 rounded-lg text-rose-300 bg-rose-500/10 hover:bg-rose-500/20" @click="remove(detail.id)">Delete</button>
        </div>
        <p v-if="detail.description" class="text-sm text-slate-300 mt-1 mb-3">{{ detail.description }}</p>

        <div class="flex gap-2 mb-3">
          <input v-model="query" placeholder="recall — search this stream…" class="flex-1 px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm outline-none focus:border-white/25" @keyup.enter="recall" />
          <button class="text-xs px-3 rounded-lg bg-white/5 hover:bg-white/10" @click="recall">{{ query.trim() ? 'Recall' : 'Recent' }}</button>
          <button v-if="results != null" class="text-xs px-2 rounded-lg bg-white/5 hover:bg-white/10" @click="results = null; query = ''">Clear</button>
        </div>

        <p class="text-xs uppercase tracking-wide text-slate-500 mb-2">{{ results != null ? 'Recall results' : 'Recent events' }}</p>
        <div v-if="!shown.length" class="text-sm text-slate-500">No events yet.</div>
        <ul class="space-y-2">
          <li v-for="(e, i) in shown" :key="e.id || i" class="text-sm border-l-2 pl-3" style="border-color: rgb(var(--brand-violet) / 0.5)">
            <div class="text-[11px] text-slate-500">{{ fmtDate(e.ts) }} · <span class="text-slate-400">{{ e.kind }}</span><span v-if="e.source"> · {{ e.source }}</span></div>
            <div class="text-slate-200 whitespace-pre-wrap">{{ e.text }}</div>
          </li>
        </ul>
      </div>
      <div v-else class="rounded-2xl border border-white/10 bg-white/[0.03] p-8 text-center text-slate-500 text-sm">Select or create a stream.</div>
    </div>
  </div>
</template>
