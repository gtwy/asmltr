<script setup>
defineProps({
  label: { type: String, required: true },
  value: { type: [String, Number], default: '—' },
  unit: { type: String, default: '' },
  sub: { type: String, default: '' },
  accent: { type: String, default: '#8B5CF6' },
  // 0..1 ratio for the little progress bar (optional)
  ratio: { type: Number, default: null }
})
</script>

<template>
  <div class="glass glass-hover relative overflow-hidden p-4">
    <div
      class="pointer-events-none absolute -right-6 -top-6 h-20 w-20 rounded-full opacity-20 blur-2xl"
      :style="{ backgroundColor: accent }"
    ></div>
    <div class="text-[11px] font-medium uppercase tracking-wider text-slate-400">{{ label }}</div>
    <div class="mt-1 flex items-baseline gap-1">
      <span class="text-2xl font-bold tabular-nums text-white">{{ value }}</span>
      <span v-if="unit" class="text-sm font-medium text-slate-400">{{ unit }}</span>
    </div>
    <div v-if="sub" class="mt-0.5 text-[11px] text-slate-500">{{ sub }}</div>
    <div v-if="ratio != null" class="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
      <div
        class="h-full rounded-full transition-all duration-500"
        :style="{
          width: Math.min(100, Math.max(0, ratio * 100)) + '%',
          background: `linear-gradient(90deg, ${accent}, #EC4899)`
        }"
      ></div>
    </div>
  </div>
</template>
