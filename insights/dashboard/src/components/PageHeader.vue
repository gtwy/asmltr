<script setup>
defineProps({
  title: { type: String, required: true },
  subtitle: { type: String, default: '' }
})
</script>

<template>
  <header class="mb-5 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
    <div>
      <h1 class="text-xl font-bold tracking-tight text-white sm:text-2xl">
        <span class="gradient-text">{{ title }}</span>
      </h1>
      <p v-if="subtitle" class="mt-0.5 text-sm text-slate-400">{{ subtitle }}</p>
    </div>
    <div class="flex items-center gap-2">
      <slot name="actions" />
    </div>
  </header>
</template>
