<script setup>
// Create/edit modal for a role (a reusable named capability set referenced by
// grants). Roles upsert via POST /trust/roles with an optional id. Create mode
// lets you set the id; edit mode shows it read-only. Fields: id (create),
// name, allow/requires_approval/forbidden (TagArrayInput), bypass_moderation /
// strict_mode toggles, notes. Submit -> trust store saveRole().
import { computed, reactive, ref } from 'vue'
import ModalShell from './ModalShell.vue'
import TagArrayInput from './TagArrayInput.vue'
import { useTrustStore } from '@/stores/trust'

const props = defineProps({
  role: { type: Object, default: null } // present => edit mode
})
const emit = defineEmits(['close', 'saved'])

const store = useTrustStore()
const isEdit = computed(() => !!props.role)

const form = reactive({
  id: isEdit.value ? props.role.id : '',
  name: isEdit.value ? props.role.name || '' : '',
  allow: isEdit.value ? [...(props.role.allow || [])] : [],
  requires_approval: isEdit.value ? [...(props.role.requires_approval || [])] : [],
  forbidden: isEdit.value ? [...(props.role.forbidden || [])] : [],
  bypass_moderation: isEdit.value ? !!props.role.bypass_moderation : false,
  strict_mode: isEdit.value ? !!props.role.strict_mode : false,
  notes: isEdit.value ? props.role.notes || '' : ''
})

const submitting = ref(false)
const error = ref(null)

const canSubmit = computed(() => {
  if (form.name.trim() === '') return false
  if (!isEdit.value && form.id.trim() === '') return false
  return true
})

async function onSubmit() {
  if (!canSubmit.value || submitting.value) return
  submitting.value = true
  error.value = null
  try {
    const payload = {
      id: isEdit.value ? props.role.id : form.id.trim(),
      name: form.name.trim(),
      allow: form.allow,
      requires_approval: form.requires_approval,
      forbidden: form.forbidden,
      bypass_moderation: form.bypass_moderation,
      strict_mode: form.strict_mode,
      notes: form.notes.trim()
    }
    await store.saveRole(payload)
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
    :title="isEdit ? 'Edit role' : 'Add role'"
    :subtitle="isEdit ? role.id : 'new role'"
    wide
    @close="emit('close')"
  >
    <form class="flex flex-col gap-5" @submit.prevent="onSubmit">
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div v-if="!isEdit">
          <label class="mb-1 flex items-center gap-2 text-sm font-medium text-slate-200">
            <span>Role id</span><span class="text-rose-400">*</span>
          </label>
          <input v-model="form.id" type="text" class="field-input font-mono" placeholder="e.g. developer" />
        </div>
        <div :class="isEdit ? 'sm:col-span-2' : ''">
          <label class="mb-1 flex items-center gap-2 text-sm font-medium text-slate-200">
            <span>Name</span><span class="text-rose-400">*</span>
          </label>
          <input v-model="form.name" type="text" class="field-input" placeholder="e.g. developer" />
        </div>
      </div>

      <div>
        <label class="mb-1 block text-sm font-medium text-emerald-300">Allow</label>
        <TagArrayInput v-model="form.allow" accent="#34D399" placeholder="e.g. code_read" />
      </div>
      <div>
        <label class="mb-1 block text-sm font-medium text-amber-300">Requires approval</label>
        <TagArrayInput v-model="form.requires_approval" accent="#FBBF24" placeholder="e.g. tool_execution" />
      </div>
      <div>
        <label class="mb-1 block text-sm font-medium text-rose-300">Forbidden</label>
        <TagArrayInput v-model="form.forbidden" accent="#F87171" placeholder="e.g. credential_access" />
      </div>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div class="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5">
          <div>
            <div class="text-sm font-medium text-slate-200">Bypass moderation</div>
            <div class="text-xs text-slate-500">Skip the moderation gate.</div>
          </div>
          <button
            type="button"
            role="switch"
            :aria-checked="form.bypass_moderation"
            class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors"
            :class="form.bypass_moderation ? 'bg-eve-gradient' : 'bg-white/10'"
            @click="form.bypass_moderation = !form.bypass_moderation"
          >
            <span
              class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform"
              :class="form.bypass_moderation ? 'translate-x-6' : 'translate-x-1'"
            ></span>
          </button>
        </div>
        <div class="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5">
          <div>
            <div class="text-sm font-medium text-slate-200">Strict mode</div>
            <div class="text-xs text-slate-500">Tighter enforcement of limits.</div>
          </div>
          <button
            type="button"
            role="switch"
            :aria-checked="form.strict_mode"
            class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors"
            :class="form.strict_mode ? 'bg-eve-gradient' : 'bg-white/10'"
            @click="form.strict_mode = !form.strict_mode"
          >
            <span
              class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform"
              :class="form.strict_mode ? 'translate-x-6' : 'translate-x-1'"
            ></span>
          </button>
        </div>
      </div>

      <div>
        <label class="mb-1 block text-sm font-medium text-slate-200">Notes</label>
        <textarea v-model="form.notes" rows="2" class="field-input resize-y" placeholder="What this role is for…"></textarea>
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
        class="rounded-xl bg-eve-gradient px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-eve-violet/30 transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
        @click="onSubmit"
      >
        {{ submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Create role' }}
      </button>
    </template>
  </ModalShell>
</template>

<style scoped>
.field-input {
  @apply w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-100 outline-none transition-colors;
  @apply placeholder:text-slate-600 focus:border-eve-violet/60 focus:bg-white/[0.06];
}
</style>
