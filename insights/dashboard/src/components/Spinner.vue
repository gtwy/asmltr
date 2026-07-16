<template>
  <!-- Inline button/inline spinner. Uses currentColor so it inherits the button's text color. -->
  <span
    class="inline-block shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent border-t-transparent align-[-0.125em]"
    :class="sizeClass"
    role="status"
    aria-label="loading"
  ></span>
</template>

<script setup>
import { computed } from 'vue'
const props = defineProps({ size: { type: String, default: 'sm' } })
const sizeClass = computed(() => ({ xs: 'h-3 w-3', sm: 'h-3.5 w-3.5', md: 'h-4 w-4' }[props.size] || 'h-3.5 w-3.5'))
</script>
