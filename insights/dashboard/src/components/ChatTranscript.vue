<script setup>
// Read-only chat transcript for a session_id — the same event→bubble rendering the floating session
// chat uses (thinking, tool calls + results, assistant/user turns), minus the composer. Loads the
// session's recorded events and live-merges any new ones from the collector store (so a still-running
// job streams in). Used by the Schedules last-run view.
import { ref, computed, watch, onMounted } from 'vue'
import { useCollectorStore } from '@/stores/collector'
import { api, parsePayload } from '@/services/api'
import { truncate } from '@/lib/format'
import { eventRow } from '@/lib/transcript'

const props = defineProps({
  sessionId: { type: String, default: '' },
  emptyText: { type: String, default: 'No events recorded for this run yet.' },
})

const store = useCollectorStore()
const seeded = ref([])
const maxSeededTs = ref(0)
const loading = ref(false)

async function load() {
  if (!props.sessionId) { seeded.value = []; maxSeededTs.value = 0; return }
  loading.value = true
  try {
    const data = await api.events({ session: props.sessionId, limit: 400 })
    // api.events returns newest-first; reverse to chronological (matches the floating chat).
    seeded.value = (data.events || []).map((e) => ({ ...e, _payload: parsePayload(e.payload) })).reverse()
    maxSeededTs.value = seeded.value.reduce((m, e) => Math.max(m, e.ts), 0)
  } catch (_) { seeded.value = [] }
  finally { loading.value = false }
}
onMounted(load)
watch(() => props.sessionId, load)

// Live-merge collector-store events newer than the seeded snapshot, so a running job streams in.
const history = computed(() => {
  const live = store.events
    .filter((e) => e.session_id === props.sessionId && e.ts > maxSeededTs.value)
    .slice().reverse()
  return [...seeded.value, ...live]
})
const rows = computed(() => history.value.map(eventRow))

const expanded = ref({})
function toggleExpand(i) { expanded.value = { ...expanded.value, [i]: !expanded.value[i] } }
</script>

<template>
  <div class="space-y-2.5">
    <p v-if="loading" class="py-6 text-center text-sm text-slate-500">loading run…</p>
    <p v-else-if="!rows.length" class="py-6 text-center text-sm text-slate-500">{{ emptyText }}</p>
    <template v-for="(r, i) in rows" :key="i">
      <!-- user -->
      <div v-if="r.kind === 'user'" class="flex justify-end">
        <div class="max-w-[82%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm border border-brand-violet/30 bg-brand-violet/15 px-3 py-2 text-[13px] leading-snug text-violet-100">{{ r.text }}</div>
      </div>
      <!-- assistant -->
      <div v-else-if="r.kind === 'assistant'" class="flex justify-start">
        <div class="max-w-[82%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-sm border border-white/10 bg-white/[0.05] px-3 py-2 text-[13px] leading-snug"
             :class="r.error ? 'text-rose-300' : 'text-slate-100'">
          <span>{{ r.text }}</span>
          <span v-if="r.error" class="block text-[11px] text-rose-400/80"><AppIcon glyph="⚠" /> {{ r.error }}</span>
        </div>
      </div>
      <!-- activity: thinking / tool / result / tokens / etc. -->
      <div v-else class="flex items-start gap-1.5 pl-1 text-[11px] text-slate-500">
        <AppIcon :glyph="r.icon" class="shrink-0 select-none opacity-80" />
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
</template>
