<script setup>
// "Add identifier" modal for a principal. Surface is picked from the aggregated
// identifierFormats (across connector types) plus the generic apikey/mcp
// surfaces; the chosen format drives the value input's placeholder and an
// optional HTML pattern hint. Submit -> trust store addIdentifier().
import { computed, reactive, ref } from 'vue'
import ModalShell from './ModalShell.vue'
import { useTrustStore } from '@/stores/trust'

const props = defineProps({
  principal: { type: Object, required: true }
})
const emit = defineEmits(['close', 'saved'])

const store = useTrustStore()
const surfaces = computed(() => store.identifierSurfaces)

const form = reactive({
  surface: surfaces.value[0]?.surface || '',
  value: ''
})

const submitting = ref(false)
const error = ref(null)

const fmt = computed(() => store.surfaceFormat(form.surface))
const placeholder = computed(() => fmt.value?.placeholder || 'identifier value')
const pattern = computed(() => fmt.value?.pattern || null)

const canSubmit = computed(() => form.surface !== '' && form.value.trim() !== '')

async function onSubmit() {
  if (!canSubmit.value || submitting.value) return
  submitting.value = true
  error.value = null
  try {
    await store.addIdentifier(props.principal.id, {
      surface: form.surface,
      value: form.value.trim()
    })
    emit('saved')
    emit('close')
  } catch (e) {
    error.value = e.message
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <ModalShell
    title="Add identifier"
    :subtitle="principal.display_name"
    @close="emit('close')"
  >
    <form class="flex flex-col gap-5" @submit.prevent="onSubmit">
      <!-- surface picker -->
      <div>
        <label class="mb-1 flex items-center gap-2 text-sm font-medium text-slate-200">
          <span>Surface</span><span class="text-rose-400">*</span>
        </label>
        <select v-model="form.surface" class="field-input">
          <option v-for="s in surfaces" :key="s.surface" :value="s.surface">
            {{ s.label }} ({{ s.surface }})
          </option>
        </select>
        <p class="mt-1 text-xs text-slate-500">
          Where this user is identified — channels from registered connectors plus generic apikey / mcp.
        </p>
      </div>

      <!-- value -->
      <div>
        <label class="mb-1 flex items-center gap-2 text-sm font-medium text-slate-200">
          <span>Value</span><span class="text-rose-400">*</span>
        </label>
        <input
          v-model="form.value"
          type="text"
          class="field-input font-mono"
          :placeholder="placeholder"
          :pattern="pattern || undefined"
        />
        <p v-if="pattern" class="mt-1 text-xs text-slate-500">
          Expected format: <code class="font-mono">{{ pattern }}</code>
        </p>
      </div>

      <p v-if="error" class="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
        {{ error }}
      </p>
    </form>

    <template #footer>
      <button
        type="button"
        class="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-300 transition-colors hover:bg-white/10"
        @click="emit('close')"
      >
        Cancel
      </button>
      <button
        type="button"
        :disabled="!canSubmit || submitting"
        class="rounded-xl bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-brand-violet/30 transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
        @click="onSubmit"
      >
        {{ submitting ? 'Adding…' : 'Add identifier' }}
      </button>
    </template>
  </ModalShell>
</template>

<style scoped>
.field-input {
  @apply w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-100 outline-none transition-colors;
  @apply placeholder:text-slate-600 focus:border-brand-violet/60 focus:bg-white/[0.06];
}
select.field-input option {
  @apply bg-slate-900 text-slate-100;
}
</style>
