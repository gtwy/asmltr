<script setup>
// "Test what someone can do" panel. Pick a channel/surface, enter a raw id
// and/or username (and optional scope id), POST /trust/resolve, and render the
// effective trust: tier, ALLOWED / requires-approval / forbidden lists, the
// bypass/strict flags, the scope label, and whether it hit default-deny
// (is_default). Read-only — never mutates anything.
import { computed, reactive } from 'vue'
import { useTrustStore } from '@/stores/trust'
import { surfaceMeta } from '@/lib/format'

const store = useTrustStore()
const surfaces = computed(() => store.identifierSurfaces)

const form = reactive({
  channel: surfaces.value[0]?.surface || 'discord',
  raw_id: '',
  raw_username: '',
  api_key: '',
  scope_id: ''
})

const result = computed(() => store.resolveResult)
const error = computed(() => store.resolveError)

const canRun = computed(
  () => form.channel && (form.raw_id.trim() || form.raw_username.trim() || form.api_key.trim())
)

async function run() {
  if (!canRun.value) return
  const sender = {}
  if (form.raw_id.trim()) sender.raw_id = form.raw_id.trim()
  if (form.raw_username.trim()) sender.raw_username = form.raw_username.trim()
  if (form.api_key.trim()) sender.api_key = form.api_key.trim()
  const context = {}
  if (form.scope_id.trim()) context.scope_id = form.scope_id.trim()
  await store.resolve({ channel: form.channel, sender, context })
}

function chanMeta(s) {
  return surfaceMeta(s)
}
</script>

<template>
  <div class="glass flex flex-col gap-4 p-4">
    <div>
      <h3 class="flex items-center gap-2 text-sm font-semibold text-slate-100">
        <span class="gradient-text">Resolve preview</span>
      </h3>
      <p class="mt-0.5 text-xs text-slate-500">
        Test what someone can do here — simulate an incoming sender and see the effective trust the core would apply. Read-only.
      </p>
    </div>

    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div>
        <label class="mb-1 block text-xs font-medium text-slate-300">Channel / surface</label>
        <select v-model="form.channel" class="field-input">
          <option v-for="s in surfaces" :key="s.surface" :value="s.surface">
            {{ s.label }} ({{ s.surface }})
          </option>
        </select>
      </div>
      <div>
        <label class="mb-1 block text-xs font-medium text-slate-300">Scope id (optional)</label>
        <input v-model="form.scope_id" type="text" class="field-input font-mono" placeholder="e.g. guild:123" />
      </div>
      <div>
        <label class="mb-1 block text-xs font-medium text-slate-300">Raw id</label>
        <input v-model="form.raw_id" type="text" class="field-input font-mono" placeholder="platform user id" />
      </div>
      <div>
        <label class="mb-1 block text-xs font-medium text-slate-300">Raw username</label>
        <input v-model="form.raw_username" type="text" class="field-input font-mono" placeholder="@handle" />
      </div>
      <div class="sm:col-span-2">
        <label class="mb-1 block text-xs font-medium text-slate-300">API key (optional)</label>
        <input v-model="form.api_key" type="text" class="field-input font-mono" placeholder="for apikey / mcp surfaces" />
      </div>
    </div>

    <div class="flex items-center gap-2">
      <button
        type="button"
        :disabled="!canRun || store.resolving"
        class="rounded-xl bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-brand-violet/30 transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
        @click="run"
      >
        {{ store.resolving ? 'Resolving…' : 'Resolve' }}
      </button>
      <button
        v-if="result || error"
        type="button"
        class="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-300 transition-colors hover:bg-white/10"
        @click="store.clearResolve()"
      >
        Clear
      </button>
    </div>

    <p v-if="error" class="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
      {{ error }}
    </p>

    <!-- result -->
    <div v-if="result" class="flex flex-col gap-3 border-t border-white/10 pt-4">
      <div class="flex flex-wrap items-center gap-2">
        <span
          class="pill border"
          :style="{
            color: chanMeta(form.channel).color,
            borderColor: chanMeta(form.channel).color + '40',
            backgroundColor: chanMeta(form.channel).color + '1a'
          }"
        >
          {{ chanMeta(form.channel).icon }} {{ chanMeta(form.channel).label }}
        </span>
        <span class="text-sm font-semibold text-slate-100">{{ result.display_name }}</span>
        <span class="font-mono text-[11px] text-slate-500">{{ result.user_key }}</span>
      </div>

      <div class="flex flex-wrap items-center gap-1.5">
        <span class="pill border border-violet-400/30 bg-violet-400/10 text-violet-300">tier {{ result.trust_tier }}</span>
        <span
          v-if="result.is_default"
          class="pill border border-rose-500/40 bg-rose-500/15 text-rose-300"
          title="no matching principal — default-deny applied"
        >
          🚫 default-deny
        </span>
        <span v-else class="pill border border-emerald-400/30 bg-emerald-400/10 text-emerald-300">matched principal</span>
        <span v-if="result.revoked" class="pill border border-rose-500/40 bg-rose-500/15 text-rose-300">revoked</span>
        <span v-if="result.bypass_moderation" class="pill border border-pink-400/30 bg-pink-400/10 text-pink-300">⚡ bypass moderation</span>
        <span v-if="result.strict_mode" class="pill border border-white/10 bg-white/5 text-slate-300">🔒 strict</span>
        <span v-if="result.scope_label" class="pill border border-white/10 bg-white/5 font-mono text-[11px] text-slate-400">@ {{ result.scope_label }}</span>
      </div>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div class="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.04] p-3">
          <div class="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-emerald-300">Allowed</div>
          <div v-if="result.permissions?.length" class="flex flex-wrap gap-1">
            <span v-for="c in result.permissions" :key="c" class="cap-chip text-emerald-300">{{ c }}</span>
          </div>
          <p v-else class="text-xs text-slate-600">none</p>
        </div>
        <div class="rounded-xl border border-amber-400/20 bg-amber-400/[0.04] p-3">
          <div class="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-amber-300">Requires approval</div>
          <div v-if="result.requires_approval?.length" class="flex flex-wrap gap-1">
            <span v-for="c in result.requires_approval" :key="c" class="cap-chip text-amber-300">{{ c }}</span>
          </div>
          <p v-else class="text-xs text-slate-600">none</p>
        </div>
        <div class="rounded-xl border border-rose-500/20 bg-rose-500/[0.04] p-3">
          <div class="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-rose-300">Forbidden</div>
          <div v-if="result.forbidden?.length" class="flex flex-wrap gap-1">
            <span v-for="c in result.forbidden" :key="c" class="cap-chip text-rose-300">{{ c }}</span>
          </div>
          <p v-else class="text-xs text-slate-600">none</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.field-input {
  @apply w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-100 outline-none transition-colors;
  @apply placeholder:text-slate-600 focus:border-brand-violet/60 focus:bg-white/[0.06];
}
select.field-input option {
  @apply bg-slate-900 text-slate-100;
}
.cap-chip {
  @apply rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[11px];
}
</style>
