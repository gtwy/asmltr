<script setup>
import { onMounted, onUnmounted, ref, computed } from 'vue'
import { useCollectorStore } from '@/stores/collector'
import PageHeader from '@/components/PageHeader.vue'
import SessionCard from '@/components/SessionCard.vue'
import StatTile from '@/components/StatTile.vue'
import { fmtNum, surfaceMeta } from '@/lib/format'

const store = useCollectorStore()
const now = ref(Date.now())
let ticker = null

const ephemeral = computed(() =>
  store.sessions.filter((s) => s.kind === 'ephemeral').sort(byActivity)
)
const persistent = computed(() =>
  store.sessions.filter((s) => s.kind === 'persistent').sort(byActivity)
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

onMounted(() => {
  store.fetchSessions()
  store.fetchBrief()
  ticker = setInterval(() => (now.value = Date.now()), 1000)
})
onUnmounted(() => clearInterval(ticker))
</script>

<template>
  <div>
    <PageHeader title="Live" subtitle="Active sessions and persistent daemons across every surface">
      <template #actions>
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

    <!-- surface distribution -->
    <div v-if="surfacesActive.length" class="mb-6 flex flex-wrap gap-2">
      <span
        v-for="[surface, count] in surfacesActive"
        :key="surface"
        class="pill border"
        :style="{
          color: surfaceMeta(surface).color,
          borderColor: surfaceMeta(surface).color + '40',
          backgroundColor: surfaceMeta(surface).color + '1a'
        }"
      >
        {{ surfaceMeta(surface).icon }} {{ surfaceMeta(surface).label }} · {{ count }}
      </span>
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
        <SessionCard v-for="s in ephemeral" :key="s.session_id" :session="s" :now="now" />
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
        <SessionCard v-for="s in persistent" :key="s.session_id" :session="s" :now="now" />
      </div>
      <p v-else class="glass px-4 py-6 text-center text-sm text-slate-500">
        No persistent daemons registered.
      </p>
    </section>
  </div>
</template>
