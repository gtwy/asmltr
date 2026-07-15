<script setup>
import { computed } from 'vue'
import { surfaceMeta } from '@/lib/format'

const props = defineProps({
  surface: { type: String, default: '' },
  dot: { type: Boolean, default: false }
})

const meta = computed(() => surfaceMeta(props.surface))
</script>

<template>
  <span
    class="pill border"
    :style="{
      color: meta.color,
      borderColor: meta.color + '40',
      backgroundColor: meta.color + '1a'
    }"
  >
    <span v-if="dot" class="h-1.5 w-1.5 rounded-full" :style="{ backgroundColor: meta.color }"></span>
    <AppIcon v-else :glyph="meta.icon" aria-hidden="true" />
    {{ meta.label }}
  </span>
</template>
