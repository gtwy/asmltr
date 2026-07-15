<script setup>
// Shows /manager/instances/:id/logs in a scrollable terminal-style pane with a
// manual refresh. Fetches on open; the parent passes the instance for the title.
import { onMounted, nextTick, ref } from 'vue'
import ModalShell from './ModalShell.vue'
import { useManagerStore } from '@/stores/manager'

const props = defineProps({
  instance: { type: Object, required: true }
})
const emit = defineEmits(['close'])

const store = useManagerStore()
const logs = ref([])
const loading = ref(false)
const error = ref(null)
const pane = ref(null)

async function load() {
  loading.value = true
  error.value = null
  try {
    logs.value = await store.fetchLogs(props.instance.id)
    await nextTick()
    if (pane.value) pane.value.scrollTop = pane.value.scrollHeight
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <ModalShell
    :title="`Logs · ${instance.name}`"
    :subtitle="instance.id"
    wide
    @close="emit('close')"
  >
    <div
      ref="pane"
      class="max-h-[55vh] min-h-[12rem] overflow-y-auto rounded-xl border border-white/10 bg-black/40 p-3 font-mono text-xs leading-relaxed text-slate-300"
    >
      <p v-if="error" class="text-rose-400">{{ error }}</p>
      <template v-else-if="logs.length">
        <div v-for="(line, i) in logs" :key="i" class="whitespace-pre-wrap break-all">{{ line }}</div>
      </template>
      <p v-else class="text-slate-600">{{ loading ? 'Loading…' : 'No log lines yet.' }}</p>
    </div>

    <template #footer>
      <span class="mr-auto text-xs text-slate-500">{{ logs.length }} line{{ logs.length === 1 ? '' : 's' }}</span>
      <button
        type="button"
        :disabled="loading"
        class="glass glass-hover px-3 py-1.5 text-sm text-slate-300 disabled:opacity-50"
        @click="load"
      >
<AppIcon glyph="↻" /> {{ loading ? 'Refreshing…' : 'Refresh' }}
      </button>
    </template>
  </ModalShell>
</template>
