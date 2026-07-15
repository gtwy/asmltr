<script setup>
// A compact glass card for one role (reusable named capability set). Shows the
// name + id, the allow/requires_approval/forbidden chips, bypass/strict flags,
// notes, and Edit / Delete actions.
import { computed } from 'vue'

const props = defineProps({
  role: { type: Object, required: true },
  busy: { type: Boolean, default: false }
})
const emit = defineEmits(['edit', 'delete'])

const r = computed(() => props.role)
</script>

<template>
  <div class="glass glass-hover flex flex-col gap-3 p-4">
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0">
        <div class="truncate text-sm font-semibold text-slate-100" :title="r.name">{{ r.name || r.id }}</div>
        <div class="mt-0.5 truncate font-mono text-[11px] text-slate-500" :title="r.id">{{ r.id }}</div>
      </div>
      <div class="flex shrink-0 items-center gap-1.5">
        <span v-if="r.bypass_moderation" class="pill border border-pink-400/30 bg-pink-400/10 text-pink-300" title="bypasses moderation"><AppIcon glyph="⚡" /></span>
        <span v-if="r.strict_mode" class="pill border border-white/10 bg-white/5 text-slate-300" title="strict mode"><AppIcon glyph="🔒" /></span>
      </div>
    </div>

    <div class="flex flex-col gap-2">
      <div v-if="r.allow?.length">
        <div class="mb-1 text-[11px] font-semibold uppercase tracking-wider text-emerald-300">Allow</div>
        <div class="flex flex-wrap gap-1">
          <span v-for="c in r.allow" :key="c" class="cap-chip text-emerald-300">{{ c }}</span>
        </div>
      </div>
      <div v-if="r.requires_approval?.length">
        <div class="mb-1 text-[11px] font-semibold uppercase tracking-wider text-amber-300">Requires approval</div>
        <div class="flex flex-wrap gap-1">
          <span v-for="c in r.requires_approval" :key="c" class="cap-chip text-amber-300">{{ c }}</span>
        </div>
      </div>
      <div v-if="r.forbidden?.length">
        <div class="mb-1 text-[11px] font-semibold uppercase tracking-wider text-rose-300">Forbidden</div>
        <div class="flex flex-wrap gap-1">
          <span v-for="c in r.forbidden" :key="c" class="cap-chip text-rose-300">{{ c }}</span>
        </div>
      </div>
    </div>

    <p v-if="r.notes" class="text-xs text-slate-500">{{ r.notes }}</p>

    <div class="mt-1 flex items-center gap-2 border-t border-white/5 pt-3">
      <button type="button" class="act" :disabled="busy" @click="emit('edit', r)"><AppIcon glyph="✎" /> Edit</button>
      <button type="button" class="act-danger ml-auto" :disabled="busy" @click="emit('delete', r)"><AppIcon glyph="🗑" /> Delete</button>
    </div>
  </div>
</template>

<style scoped>
.cap-chip {
  @apply rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[11px];
}
.act {
  @apply rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-medium text-slate-300 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50;
}
.act-danger {
  @apply rounded-lg border border-rose-500/20 bg-rose-500/5 px-2.5 py-1 text-xs font-medium text-rose-400/80 transition-colors hover:bg-rose-500/15 disabled:cursor-not-allowed disabled:opacity-50;
}
</style>
