<script setup>
// Create/edit modal for a connector instance. In "create" mode it builds an
// empty config from the schema's defaults. In "edit" mode it seeds
// name/config/enabled from the existing instance. Submit -> manager store
// create()/update(). Required-config validation mirrors the manager's own 400.
import { computed, reactive, ref } from 'vue'
import ModalShell from './ModalShell.vue'
import SchemaForm from './SchemaForm.vue'
import { useManagerStore } from '@/stores/manager'
import { connectorTypeMeta } from '@/lib/format'

const props = defineProps({
  type: { type: Object, required: true }, // connector type def (with configSchema)
  instance: { type: Object, default: null } // present => edit mode
})
const emit = defineEmits(['close', 'saved'])

const store = useManagerStore()
const isEdit = computed(() => !!props.instance)
const meta = computed(() => connectorTypeMeta(props.type.type, props.type.displayName))

function defaultsFromSchema(schema) {
  const out = {}
  const propsDef = (schema && schema.properties) || {}
  for (const [key, def] of Object.entries(propsDef)) {
    if (def.default !== undefined) out[key] = def.default
    else if (def.type === 'array') out[key] = []
    else if (def.type === 'boolean') out[key] = false
    else out[key] = ''
  }
  return out
}

const form = reactive({
  name: isEdit.value ? props.instance.name : '',
  enabled: isEdit.value ? props.instance.enabled : false,
  config: isEdit.value
    ? { ...defaultsFromSchema(props.type.configSchema), ...(props.instance.config || {}) }
    : defaultsFromSchema(props.type.configSchema)
})

const submitting = ref(false)
const error = ref(null)

const missingRequired = computed(() => {
  const req = (props.type.configSchema && props.type.configSchema.required) || []
  return req.filter((k) => {
    const v = form.config[k]
    if (v == null) return true
    if (Array.isArray(v)) return false // empty array allowed (manager treats empty repos as valid)
    if (typeof v === 'string') return v.trim() === ''
    return false
  })
})

const canSubmit = computed(() => form.name.trim() !== '' && missingRequired.value.length === 0)

async function onSubmit() {
  if (!canSubmit.value || submitting.value) return
  submitting.value = true
  error.value = null
  try {
    const payload = {
      name: form.name.trim(),
      config: { ...form.config },
      enabled: form.enabled
    }
    const saved = isEdit.value
      ? await store.updateInstance(props.instance.id, payload)
      : await store.createInstance({ type: props.type.type, ...payload })
    emit('saved', saved)
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
    :title="isEdit ? `Edit ${meta.label} connector` : `Add ${meta.label} connector`"
    :subtitle="isEdit ? instance.id : type.displayName"
    wide
    @close="emit('close')"
  >
    <form class="flex flex-col gap-5" @submit.prevent="onSubmit">
      <!-- name -->
      <div>
        <label class="mb-1 flex items-center gap-2 text-sm font-medium text-slate-200">
          <span>Name</span><span class="text-rose-400">*</span>
        </label>
        <input
          v-model="form.name"
          type="text"
          class="w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-brand-violet/60 focus:bg-white/[0.06]"
          placeholder="e.g. 3dprintpittsburgh"
        />
      </div>

      <!-- enabled toggle -->
      <div class="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5">
        <div>
          <div class="text-sm font-medium text-slate-200">Enabled</div>
          <div class="text-xs text-slate-500">Start this connector now and on manager boot.</div>
        </div>
        <button
          type="button"
          role="switch"
          :aria-checked="form.enabled"
          class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors"
          :class="form.enabled ? 'bg-brand-gradient' : 'bg-white/10'"
          @click="form.enabled = !form.enabled"
        >
          <span
            class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform"
            :class="form.enabled ? 'translate-x-6' : 'translate-x-1'"
          ></span>
        </button>
      </div>

      <!-- schema-driven config -->
      <div class="border-t border-white/10 pt-4">
        <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Configuration</h3>
        <SchemaForm
          v-model="form.config"
          :schema="type.configSchema"
          :credential-keys="type.credentialKeys || []"
        />
      </div>

      <p v-if="error" class="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
        {{ error }}
      </p>
    </form>

    <template #footer>
      <span v-if="missingRequired.length" class="mr-auto text-xs text-amber-300/80">
        Missing required: {{ missingRequired.join(', ') }}
      </span>
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
        {{ submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Create connector' }}
      </button>
    </template>
  </ModalShell>
</template>
