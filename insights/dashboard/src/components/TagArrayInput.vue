<script setup>
// Tag-array editor: a v-model'd array of strings rendered as removable chips
// with a single "type + Enter (or comma) to add" input. Reused for capability
// lists (allow / requires_approval / forbidden). Mirrors SchemaForm's scalar
// array styling but is chip-based for compact capability sets.
import { ref, computed } from 'vue'

const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  placeholder: { type: String, default: 'add capability…' },
  // accent color for chips (hex). Defaults to violet brand.
  accent: { type: String, default: '#8B5CF6' }
})
const emit = defineEmits(['update:modelValue'])

const draft = ref('')

const tags = computed(() => (Array.isArray(props.modelValue) ? props.modelValue : []))

function commit(raw) {
  // allow comma- or whitespace-separated bulk entry
  const parts = String(raw)
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (!parts.length) return
  const next = tags.value.slice()
  for (const p of parts) {
    if (!next.includes(p)) next.push(p)
  }
  emit('update:modelValue', next)
  draft.value = ''
}

function onKeydown(e) {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault()
    commit(draft.value)
  } else if (e.key === 'Backspace' && draft.value === '' && tags.value.length) {
    // backspace on empty input removes the last chip
    remove(tags.value.length - 1)
  }
}

function onBlur() {
  if (draft.value.trim()) commit(draft.value)
}

function remove(idx) {
  const next = tags.value.slice()
  next.splice(idx, 1)
  emit('update:modelValue', next)
}
</script>

<template>
  <div
    class="flex flex-wrap items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] px-2 py-1.5 transition-colors focus-within:border-brand-violet/60 focus-within:bg-white/[0.06]"
  >
    <span
      v-for="(tag, idx) in tags"
      :key="tag + idx"
      class="pill border"
      :style="{ color: accent, borderColor: accent + '40', backgroundColor: accent + '1a' }"
    >
      <span class="font-mono text-[11px]">{{ tag }}</span>
      <button
        type="button"
        class="ml-1 text-[10px] opacity-70 transition-opacity hover:opacity-100"
        :aria-label="`remove ${tag}`"
        @click="remove(idx)"
      >
        <AppIcon glyph="✕" />
      </button>
    </span>
    <input
      v-model="draft"
      type="text"
      class="min-w-[8rem] flex-1 bg-transparent px-1 py-1 text-sm text-slate-100 outline-none placeholder:text-slate-600"
      :placeholder="tags.length ? '' : placeholder"
      @keydown="onKeydown"
      @blur="onBlur"
    />
  </div>
</template>
