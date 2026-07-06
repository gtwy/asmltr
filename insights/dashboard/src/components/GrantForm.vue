<script setup>
// "Add grant" modal for a principal. Two modes via a segmented toggle:
//   - role:   pick an existing role from /trust/roles (role_id only)
//   - inline: enter capability lists (allow / requires_approval / forbidden via
//             TagArrayInput) + bypass_moderation / strict_mode toggles
// Either mode can carry an OPTIONAL scope (scope_surface + scope_id) to limit
// the grant to one context (e.g. a single Discord guild). Blank scope = global.
// Submit -> trust store addGrant().
import { computed, reactive, ref } from 'vue'
import ModalShell from './ModalShell.vue'
import TagArrayInput from './TagArrayInput.vue'
import { useTrustStore } from '@/stores/trust'

const props = defineProps({
  principal: { type: Object, required: true }
})
const emit = defineEmits(['close', 'saved'])

const store = useTrustStore()
const surfaces = computed(() => store.identifierSurfaces)

const mode = ref('role') // 'role' | 'inline'

const form = reactive({
  role_id: store.roles[0]?.id || '',
  allow: [],
  requires_approval: [],
  forbidden: [],
  bypass_moderation: false,
  strict_mode: false,
  scope_surface: '',
  scope_id: ''
})

const submitting = ref(false)
const error = ref(null)

const canSubmit = computed(() => {
  if (mode.value === 'role') return !!form.role_id
  // inline: require at least one capability somewhere to be meaningful
  return (
    form.allow.length > 0 ||
    form.requires_approval.length > 0 ||
    form.forbidden.length > 0 ||
    form.bypass_moderation ||
    form.strict_mode
  )
})

async function onSubmit() {
  if (!canSubmit.value || submitting.value) return
  submitting.value = true
  error.value = null
  try {
    const payload = {}
    if (mode.value === 'role') {
      payload.role_id = form.role_id
    } else {
      payload.allow = form.allow
      payload.requires_approval = form.requires_approval
      payload.forbidden = form.forbidden
      payload.bypass_moderation = form.bypass_moderation
      payload.strict_mode = form.strict_mode
    }
    // optional scope (applies to either mode)
    if (form.scope_surface && form.scope_id.trim()) {
      payload.scope_surface = form.scope_surface
      payload.scope_id = form.scope_id.trim()
    }
    await store.addGrant(props.principal.id, payload)
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
    title="Add grant"
    :subtitle="principal.display_name"
    wide
    @close="emit('close')"
  >
    <form class="flex flex-col gap-5" @submit.prevent="onSubmit">
      <!-- mode toggle -->
      <div class="flex gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1">
        <button
          type="button"
          class="seg"
          :class="mode === 'role' ? 'seg-on' : ''"
          @click="mode = 'role'"
        >
          Use a role
        </button>
        <button
          type="button"
          class="seg"
          :class="mode === 'inline' ? 'seg-on' : ''"
          @click="mode = 'inline'"
        >
          Inline capabilities
        </button>
      </div>

      <!-- role mode -->
      <div v-if="mode === 'role'">
        <label class="mb-1 flex items-center gap-2 text-sm font-medium text-slate-200">
          <span>Role</span><span class="text-rose-400">*</span>
        </label>
        <select v-model="form.role_id" class="field-input">
          <option v-if="!store.roles.length" value="">No roles defined yet</option>
          <option v-for="r in store.roles" :key="r.id" :value="r.id">
            {{ r.name || r.id }}
          </option>
        </select>
        <p class="mt-1 text-xs text-slate-500">
          Grants this role's capability set. Manage roles in the Roles section below.
        </p>
      </div>

      <!-- inline mode -->
      <div v-else class="flex flex-col gap-4">
        <div>
          <label class="mb-1 block text-sm font-medium text-emerald-300">Allow</label>
          <TagArrayInput v-model="form.allow" accent="#34D399" placeholder="e.g. technical_discussion (or * for all)" />
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
              :class="form.bypass_moderation ? 'bg-brand-gradient' : 'bg-white/10'"
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
              :class="form.strict_mode ? 'bg-brand-gradient' : 'bg-white/10'"
              @click="form.strict_mode = !form.strict_mode"
            >
              <span
                class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform"
                :class="form.strict_mode ? 'translate-x-6' : 'translate-x-1'"
              ></span>
            </button>
          </div>
        </div>
      </div>

      <!-- optional scope -->
      <div class="border-t border-white/10 pt-4">
        <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Scope (optional)</h3>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label class="mb-1 block text-sm font-medium text-slate-200">Scope surface</label>
            <select v-model="form.scope_surface" class="field-input">
              <option value="">— global —</option>
              <option v-for="s in surfaces" :key="s.surface" :value="s.surface">
                {{ s.label }} ({{ s.surface }})
              </option>
            </select>
          </div>
          <div>
            <label class="mb-1 block text-sm font-medium text-slate-200">Scope id</label>
            <input
              v-model="form.scope_id"
              type="text"
              class="field-input font-mono"
              placeholder="e.g. guild:123456789"
            />
          </div>
        </div>
        <p class="mt-1 text-xs text-slate-500">Leave blank for a global grant. Both fields are needed to scope.</p>
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
        {{ submitting ? 'Adding…' : 'Add grant' }}
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
.seg {
  @apply flex-1 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-400 transition-colors hover:text-slate-200;
}
.seg-on {
  @apply bg-white/[0.07] text-white;
}
</style>
