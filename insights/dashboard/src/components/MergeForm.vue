<script setup>
// Merge one principal (the "source", being absorbed) into another (the "target", survivor).
// Identifiers + grants move to the target, the higher trust tier is kept, the source is deleted.
import { ref, computed } from 'vue'
import ModalShell from './ModalShell.vue'

const props = defineProps({
  source: { type: Object, required: true },
  principals: { type: Array, default: () => [] }
})
const emit = defineEmits(['close', 'merge'])

const targetId = ref('')
const busy = ref(false)
const targets = computed(() =>
  props.principals.filter((p) => p.id !== props.source.id).slice().sort((a, b) => (a.display_name || '').localeCompare(b.display_name || ''))
)
const target = computed(() => targets.value.find((p) => p.id === targetId.value) || null)
const identCount = (p) => (p.identifiers?.length || 0)
const grantCount = (p) => (p.grants?.length || 0)

async function confirm() {
  if (!target.value) return
  busy.value = true
  try { emit('merge', { sourceId: props.source.id, targetId: target.value.id }) } finally { busy.value = false }
}
</script>

<template>
  <ModalShell title="Merge user" :subtitle="source.display_name + ' → …'" @close="emit('close')">
    <p class="text-sm text-slate-300">
      Merge <span class="font-semibold text-slate-100">{{ source.display_name }}</span>
      <span class="font-mono text-xs text-slate-500">({{ source.id }})</span> into another user —
      for records that are the same person split across connectors.
    </p>

    <!-- what the source brings -->
    <div class="mt-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-slate-400">
      <div class="mb-1 font-semibold text-slate-300">This record contributes:</div>
      <div>{{ identCount(source) }} identifier(s), {{ grantCount(source) }} grant(s), tier {{ source.default_tier }}</div>
      <div v-if="source.identifiers?.length" class="mt-1 flex flex-wrap gap-1">
        <span v-for="id in source.identifiers" :key="id.id" class="pill border border-white/10 bg-white/5 font-mono text-[10px] text-slate-400">{{ id.surface }}:{{ id.value }}</span>
      </div>
    </div>

    <!-- pick the survivor -->
    <label class="mt-4 block text-xs font-semibold uppercase tracking-wide text-slate-400">Merge into (this record survives)</label>
    <select
      v-model="targetId"
      class="mt-1 w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-100 outline-none focus:border-brand-violet/60"
    >
      <option value="" disabled>Choose the user to keep…</option>
      <option v-for="p in targets" :key="p.id" :value="p.id">
        {{ p.display_name }} — {{ identCount(p) }} id / {{ grantCount(p) }} grant · tier {{ p.default_tier }}
      </option>
    </select>

    <div v-if="target" class="mt-3 rounded-lg border border-brand-violet/20 bg-brand-violet/5 px-3 py-2 text-xs text-violet-200/90">
      After merge, <span class="font-semibold">{{ target.display_name }}</span> will own
      {{ identCount(source) + identCount(target) }} identifiers and
      {{ grantCount(source) + grantCount(target) }} grants, keep the higher tier
      ({{ Math.max(source.default_tier, target.default_tier) }}), and
      <span class="font-semibold text-rose-300">{{ source.display_name }}</span> will be deleted.
    </div>

    <template #footer>
      <button type="button" class="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-slate-300 hover:bg-white/10" @click="emit('close')">Cancel</button>
      <button
        type="button"
        :disabled="!target || busy"
        class="rounded-lg bg-brand-gradient px-4 py-1.5 text-sm font-semibold text-white shadow-lg shadow-brand-violet/30 disabled:opacity-40"
        @click="confirm"
      >{{ busy ? 'Merging…' : 'Merge' }}</button>
    </template>
  </ModalShell>
</template>
