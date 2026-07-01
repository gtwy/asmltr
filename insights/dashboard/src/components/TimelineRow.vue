<script setup>
import { computed } from 'vue'
import SurfaceBadge from './SurfaceBadge.vue'
import { eventTypeColor, fmtTime, fmtNum, fmtUsd, truncate } from '@/lib/format'

const props = defineProps({
  event: { type: Object, required: true }
})

const typeColor = computed(() => eventTypeColor(props.event.event_type))

// Build a compact, human-readable preview from the parsed payload.
const preview = computed(() => {
  const p = props.event._payload
  if (!p) return ''
  if (p._raw) return truncate(p._raw, 120)
  // pick the most informative keys, fall back to a compact JSON
  const keys = Object.keys(p)
  const interesting = ['text', 'message', 'content', 'task', 'tool', 'name', 'chars', 'decision', 'reason', 'title']
  const picked = interesting.filter((k) => k in p && p[k] != null)
  if (picked.length) {
    return truncate(picked.map((k) => `${k}: ${stringify(p[k])}`).join('  ·  '), 140)
  }
  if (keys.length) {
    return truncate(keys.map((k) => `${k}: ${stringify(p[k])}`).join('  ·  '), 140)
  }
  return ''
})

function stringify(v) {
  if (v == null) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

const cost = computed(() => fmtUsd(props.event.cost_usd))
const tokens = computed(() => {
  const i = props.event.tokens_in || 0
  const o = props.event.tokens_out || 0
  return i || o ? `${fmtNum(i)}→${fmtNum(o)}` : null
})
</script>

<template>
  <div
    class="group grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-b border-white/5 px-3 py-2.5 text-sm transition-colors hover:bg-white/[0.03] sm:grid-cols-[68px_120px_1fr]"
  >
    <!-- time -->
    <div class="font-mono text-[11px] tabular-nums text-slate-500">{{ fmtTime(event.ts) }}</div>

    <!-- surface + type (stacks under time on mobile) -->
    <div class="col-start-2 flex flex-wrap items-center gap-1.5 sm:col-start-2">
      <SurfaceBadge :surface="event.surface" dot />
      <span
        class="pill font-mono"
        :style="{ color: typeColor, backgroundColor: typeColor + '1a' }"
      >
        {{ event.event_type }}
      </span>
    </div>

    <!-- body -->
    <div class="col-span-2 min-w-0 sm:col-span-1 sm:col-start-3">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span v-if="event.identity" class="font-mono text-[11px] text-slate-400"
          >@{{ event.identity }}</span
        >
        <span v-if="tokens" class="font-mono text-[11px] text-violet-300/90">⟁ {{ tokens }}</span>
        <span v-if="cost" class="font-mono text-[11px] text-emerald-300/90">{{ cost }}</span>
        <span v-if="event.source" class="font-mono text-[10px] text-slate-600">via {{ event.source }}</span>
      </div>
      <div v-if="preview" class="mt-0.5 truncate text-[13px] text-slate-300" :title="preview">
        {{ preview }}
      </div>
    </div>
  </div>
</template>
