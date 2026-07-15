<script setup>
// Renders a Font Awesome glyph for the given source emoji/symbol, falling back to the raw character
// when we don't have a mapping (so nothing ever vanishes). Any class/style/aria attrs pass through.
import { computed } from 'vue'
import { faFor } from '@/icons'

defineOptions({ inheritAttrs: false })
// `name` is an explicit Font Awesome icon (e.g. ['fas','comments']) used when the source glyph is
// ambiguous/collides in the shared map; otherwise `glyph` is translated via faFor().
const props = defineProps({ glyph: { type: String, default: '' }, name: { type: [Array, String], default: null } })
const fa = computed(() => props.name || faFor(props.glyph))
</script>

<template>
  <font-awesome-icon v-if="fa" :icon="fa" v-bind="$attrs" />
  <span v-else v-bind="$attrs">{{ glyph }}</span>
</template>
