<script setup>
import { onMounted, ref, computed } from 'vue'
import { useCollectorStore } from '@/stores/collector'
import PageHeader from '@/components/PageHeader.vue'
import TimelineRow from '@/components/TimelineRow.vue'
import { surfaceMeta } from '@/lib/format'

const store = useCollectorStore()

const selectedSurfaces = ref(new Set())
const selectedIdentities = ref(new Set())
const search = ref('')

function toggle(set, val) {
  const s = new Set(set.value)
  s.has(val) ? s.delete(val) : s.add(val)
  set.value = s
}

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  return store.events.filter((e) => {
    if (selectedSurfaces.value.size && !selectedSurfaces.value.has(e.surface)) return false
    if (selectedIdentities.value.size && !selectedIdentities.value.has(e.identity)) return false
    if (q) {
      const hay = [
        e.event_type,
        e.surface,
        e.identity,
        e.source,
        e.session_id,
        e._payload ? JSON.stringify(e._payload) : ''
      ]
        .join(' ')
        .toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
})

const hasFilters = computed(
  () => selectedSurfaces.value.size || selectedIdentities.value.size || search.value.trim()
)

function clearFilters() {
  selectedSurfaces.value = new Set()
  selectedIdentities.value = new Set()
  search.value = ''
}

onMounted(() => {
  store.fetchEvents({ limit: 300 })
})
</script>

<template>
  <div>
    <PageHeader
      title="Timeline"
      subtitle="Unified cross-surface causality feed · live-appending"
    >
      <template #actions>
        <span class="text-xs text-slate-500">{{ filtered.length }} / {{ store.events.length }} events</span>
      </template>
    </PageHeader>

    <!-- filter bar -->
    <div class="glass mb-4 flex flex-col gap-3 p-3">
      <input
        v-model="search"
        type="search"
        placeholder="Search events, payloads, identities…"
        class="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-brand-violet/50 focus:outline-none focus:ring-1 focus:ring-brand-violet/40"
      />

      <div v-if="store.knownSurfaces.length" class="flex flex-col gap-2">
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="mr-1 text-[11px] uppercase tracking-wider text-slate-500">surface</span>
          <button
            v-for="s in store.knownSurfaces"
            :key="s"
            class="pill border transition-all"
            :style="
              selectedSurfaces.has(s)
                ? { color: '#fff', borderColor: surfaceMeta(s).color, backgroundColor: surfaceMeta(s).color + '55' }
                : { color: surfaceMeta(s).color, borderColor: surfaceMeta(s).color + '30', backgroundColor: surfaceMeta(s).color + '12' }
            "
            @click="toggle(selectedSurfaces, s)"
          >
            <AppIcon :glyph="surfaceMeta(s).icon" /> {{ surfaceMeta(s).label }}
          </button>
        </div>

        <div v-if="store.knownIdentities.length" class="flex flex-wrap items-center gap-1.5">
          <span class="mr-1 text-[11px] uppercase tracking-wider text-slate-500">identity</span>
          <button
            v-for="id in store.knownIdentities"
            :key="id"
            class="pill border font-mono"
            :class="
              selectedIdentities.has(id)
                ? 'border-brand-pink bg-brand-pink/30 text-white'
                : 'border-white/10 bg-white/5 text-slate-400'
            "
            @click="toggle(selectedIdentities, id)"
          >
            @{{ id }}
          </button>
        </div>
      </div>

      <button
        v-if="hasFilters"
        class="self-start text-[11px] text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline"
        @click="clearFilters"
      >
        clear filters
      </button>
    </div>

    <!-- feed -->
    <div class="glass overflow-hidden">
      <TransitionGroup name="fade">
        <TimelineRow
          v-for="e in filtered"
          :key="e.id ?? `${e.ts}-${e.session_id}-${e.event_type}`"
          :event="e"
        />
      </TransitionGroup>
      <p v-if="!filtered.length" class="px-4 py-10 text-center text-sm text-slate-500">
        {{ store.loading.events ? 'Loading…' : 'No events match the current filters.' }}
      </p>
    </div>
  </div>
</template>
