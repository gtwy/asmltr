<script setup>
import { onMounted, onUnmounted, ref, computed, watch } from 'vue'
import { useCollectorStore } from '@/stores/collector'
import PageHeader from '@/components/PageHeader.vue'
import SessionCard from '@/components/SessionCard.vue'
import SessionDetail from '@/components/SessionDetail.vue'
import StatTile from '@/components/StatTile.vue'
import { fmtNum, surfaceMeta } from '@/lib/format'
import { manager } from '@/services/manager'
import { api } from '@/services/api'

const store = useCollectorStore()
const now = ref(Date.now())
let ticker = null

// which session's details pane is open (a snapshot — its history streams live)
const selected = ref(null)

// per-channel monitored state (Discord): channel_id -> enabled. Powers the card/detail toggle.
const channelStates = ref({})
const channelBusy = ref({})
function discordChannel(sessionId) {
  const p = String(sessionId || '').split(':')
  return (p[0] === 'discord' && p[2] === 'channel') ? { instanceId: p[1], channelId: p[3] } : null
}
// the set of Discord connector instances currently visible (as a stable key so we can watch it)
const discordInstanceKey = computed(() => {
  const ids = new Set()
  for (const s of store.sessions) { const d = discordChannel(s.session_id); if (d) ids.add(d.instanceId) }
  return [...ids].sort().join(',')
})
async function loadChannelStates() {
  const instanceIds = discordInstanceKey.value ? discordInstanceKey.value.split(',') : []
  const next = {}
  for (const id of instanceIds) {
    try { const r = await manager.channels(id); for (const c of (r.channels || [])) next[c.channel_id] = c.enabled } catch (_) {}
  }
  channelStates.value = next
}
// onMounted fires before the sessions have loaded (so no Discord instances are known yet and the
// real per-channel states never get fetched — a disabled channel then looks enabled on refresh).
// Re-load whenever the set of Discord instances appears/changes.
watch(discordInstanceKey, (k) => { if (k) loadChannelStates() })
async function toggleChannel(sessionId) {
  const d = discordChannel(sessionId)
  if (!d) return
  const cur = channelStates.value[d.channelId] !== false
  channelBusy.value = { ...channelBusy.value, [d.channelId]: true }
  try {
    await manager.setChannel(d.instanceId, { channel_id: d.channelId, enabled: !cur })
    channelStates.value = { ...channelStates.value, [d.channelId]: !cur }
  } catch (_) {}
  finally { channelBusy.value = { ...channelBusy.value, [d.channelId]: false } }
}

// latest event per session (store.events is newest-first) → live card previews
const latestBySession = computed(() => {
  const map = {}
  for (const e of store.events) {
    if (e.session_id && !map[e.session_id]) map[e.session_id] = e
  }
  return map
})

// click a surface pill to filter the lists to that connector (click again to clear)
const surfaceFilter = ref(null)
function toggleSurface(s) { surfaceFilter.value = surfaceFilter.value === s ? null : s }

// content search: filter cards to sessions whose CONTENT (or metadata) matches a keyword.
const search = ref('')
const searchHits = ref({}) // session_id -> { hits, snippet } from the server-side content search
const searching = ref(false)
let searchTimer = null
watch(search, (q) => {
  clearTimeout(searchTimer)
  q = q.trim()
  if (q.length < 2) { searchHits.value = {}; searching.value = false; return }
  searching.value = true
  searchTimer = setTimeout(async () => {
    try { const r = await api.search(q); const m = {}; for (const s of (r.sessions || [])) m[s.session_id] = s; searchHits.value = m }
    catch (_) { searchHits.value = {} }
    finally { searching.value = false }
  }, 300)
})
const metaMatch = (s, q) => [s.title, s.location, s.identity, s.session_id, s.task].some((f) => f && String(f).toLowerCase().includes(q))
function matchFilter(s) {
  if (surfaceFilter.value && s.surface !== surfaceFilter.value) return false
  const q = search.value.trim().toLowerCase()
  if (q.length >= 2) return metaMatch(s, q) || !!searchHits.value[s.session_id]
  return true
}

const ephemeral = computed(() =>
  store.sessions.filter((s) => s.kind === 'ephemeral' && matchFilter(s)).sort(byActivity)
)
const persistent = computed(() =>
  store.sessions.filter((s) => s.kind === 'persistent' && matchFilter(s)).sort(byActivity)
)

function byActivity(a, b) {
  return (b.last_activity_unix || 0) - (a.last_activity_unix || 0)
}

const totalTokens = computed(() =>
  store.sessions.reduce((sum, s) => sum + (s.tokens_total || 0), 0)
)

const surfacesActive = computed(() => {
  const map = {}
  for (const s of store.sessions) map[s.surface] = (map[s.surface] || 0) + 1
  return Object.entries(map).sort((a, b) => b[1] - a[1])
})

let chanTimer = null
onMounted(() => {
  store.fetchSessions()
  store.fetchBrief()
  store.fetchEvents({ limit: 300 }) // seed the buffer so card previews render immediately
  loadChannelStates()
  ticker = setInterval(() => (now.value = Date.now()), 1000)
  chanTimer = setInterval(loadChannelStates, 15000) // refresh channel enabled/disabled state
})
onUnmounted(() => { clearInterval(ticker); clearInterval(chanTimer) })
</script>

<template>
  <div>
    <PageHeader title="Live" subtitle="Active sessions and persistent daemons across every surface">
      <template #actions>
        <div class="relative">
          <input
            v-model="search"
            type="search"
            placeholder="Search session contents…"
            class="w-56 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 pl-8 text-sm text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-brand-violet/60 focus:bg-white/[0.06] sm:w-72"
          />
          <span class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500">{{ searching ? '⏳' : '🔍' }}</span>
        </div>
        <button
          class="glass glass-hover px-3 py-1.5 text-sm text-slate-300"
          @click="store.fetchSessions()"
        >
          ↻ Refresh
        </button>
      </template>
    </PageHeader>

    <!-- summary tiles -->
    <div class="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatTile label="Active sessions" :value="store.activeSessions.length" accent="#34D399" />
      <StatTile label="Persistent" :value="persistent.length" accent="#22D3EE" />
      <StatTile label="Tokens (live)" :value="fmtNum(totalTokens)" accent="#8B5CF6" />
      <StatTile
        label="Tokens · 24h"
        :value="fmtNum(store.brief?.tokens_24h || 0)"
        accent="#EC4899"
      />
    </div>

    <!-- surface distribution — click to filter by connector -->
    <div v-if="surfacesActive.length" class="mb-6 flex flex-wrap items-center gap-2">
      <button
        v-for="[surface, count] in surfacesActive"
        :key="surface"
        type="button"
        class="pill border transition-all"
        :class="surfaceFilter && surfaceFilter !== surface ? 'opacity-40 hover:opacity-70' : 'hover:brightness-125'"
        :style="{
          color: surfaceMeta(surface).color,
          borderColor: surfaceMeta(surface).color + (surfaceFilter === surface ? 'cc' : '40'),
          backgroundColor: surfaceMeta(surface).color + (surfaceFilter === surface ? '33' : '1a')
        }"
        :title="surfaceFilter === surface ? 'Click to clear filter' : 'Filter to ' + surfaceMeta(surface).label"
        @click="toggleSurface(surface)"
      >
        {{ surfaceMeta(surface).icon }} {{ surfaceMeta(surface).label }} · {{ count }}
      </button>
      <button
        v-if="surfaceFilter"
        type="button"
        class="pill border border-white/15 bg-white/5 text-slate-400 hover:text-slate-200"
        @click="surfaceFilter = null"
      >
        ✕ clear
      </button>
    </div>

    <!-- ephemeral -->
    <section class="mb-8">
      <h2 class="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
        <span class="h-2 w-2 rounded-full bg-emerald-400 animate-pulse-dot"></span>
        Ephemeral sessions
        <span class="text-slate-600">({{ ephemeral.length }})</span>
      </h2>
      <div
        v-if="ephemeral.length"
        class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
      >
        <SessionCard v-for="s in ephemeral" :key="s.session_id" :session="s" :now="now" :preview="latestBySession[s.session_id]" :channel-state="channelStates[discordChannel(s.session_id)?.channelId]" :channel-busy="channelBusy[discordChannel(s.session_id)?.channelId]" :search-snippet="searchHits[s.session_id]?.snippet" @open="selected = $event" @toggle-channel="toggleChannel" />
      </div>
      <p v-else class="glass px-4 py-6 text-center text-sm text-slate-500">
        No ephemeral sessions right now.
      </p>
    </section>

    <!-- persistent -->
    <section>
      <h2 class="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
        <span class="h-2 w-2 rounded-full bg-cyan-400"></span>
        Persistent daemons
        <span class="text-slate-600">({{ persistent.length }})</span>
      </h2>
      <div
        v-if="persistent.length"
        class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
      >
        <SessionCard v-for="s in persistent" :key="s.session_id" :session="s" :now="now" :preview="latestBySession[s.session_id]" :channel-state="channelStates[discordChannel(s.session_id)?.channelId]" :channel-busy="channelBusy[discordChannel(s.session_id)?.channelId]" :search-snippet="searchHits[s.session_id]?.snippet" @open="selected = $event" @toggle-channel="toggleChannel" />
      </div>
      <p v-else class="glass px-4 py-6 text-center text-sm text-slate-500">
        No persistent daemons registered.
      </p>
    </section>

    <!-- conversation details + takeover pane -->
    <SessionDetail v-if="selected" :session="selected" :now="now" :channel-state="channelStates[discordChannel(selected.session_id)?.channelId]" :channel-busy="channelBusy[discordChannel(selected.session_id)?.channelId]" @close="selected = null" @toggle-channel="toggleChannel" />
  </div>
</template>
