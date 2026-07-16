<script setup>
// Vault — the TRUST Protocol credential broker + KMS. Two concerns:
//   1) a loud status banner (configured / reachable / sealed), so a degraded vault is obvious
//   2) key management: list keys (metadata only — values are write-only, never returned), add a
//      secret (name + value + minimum trust tier), delete a key.
// Integrations reference these keys by NAME (a *_ref field), so this is where those names come from.
import { onMounted, reactive, ref } from 'vue'
import { vaultApi } from '@/services/api'
import PageHeader from '@/components/PageHeader.vue'
import ModalShell from '@/components/ModalShell.vue'

// ── status ───────────────────────────────────────────────────────────────────
const status = ref(null)
const statusError = ref(null)

async function loadStatus() {
  statusError.value = null
  try {
    status.value = await vaultApi.status()
  } catch (e) {
    statusError.value = e.message
  }
}

// ── keys ─────────────────────────────────────────────────────────────────────
const secrets = ref([])
const loading = ref(false)
const error = ref(null)
const busy = reactive({}) // name -> action in flight

async function loadSecrets() {
  loading.value = true
  error.value = null
  try {
    const r = await vaultApi.secrets()
    secrets.value = r.secrets || []
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

function refresh() {
  loadStatus()
  loadSecrets()
}

// trust tier -> pill classes. SACRED is the strongest (brand-violet).
const TIER_CLASS = {
  SACRED: 'border-brand-violet/40 bg-brand-violet/10 text-violet-300',
  GUARDIAN: 'border-pink-400/30 bg-pink-400/10 text-pink-300',
  PARTNER: 'border-cyan-400/30 bg-cyan-400/10 text-cyan-300',
  COMPANION: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  NOVICE: 'border-white/10 bg-white/5 text-slate-400'
}
function tierClass(t) {
  return TIER_CLASS[t] || 'border-white/10 bg-white/5 text-slate-400'
}

async function onDelete(s) {
  if (!window.confirm(`Delete vault key "${s.name}"?\nAny integration referencing it will break. This cannot be undone.`)) return
  busy[s.name] = 'delete'
  error.value = null
  try {
    await vaultApi.removeSecret(s.name)
    await loadSecrets()
  } catch (e) {
    error.value = e.message
  } finally {
    busy[s.name] = ''
  }
}

// ── add-secret modal ─────────────────────────────────────────────────────────
const TIERS = ['NOVICE', 'COMPANION', 'PARTNER', 'GUARDIAN', 'SACRED']
const addOpen = ref(false)
const form = reactive({ name: '', value: '', min_trust: 'SACRED' })
const submitting = ref(false)
const formError = ref(null)

function openAdd() {
  form.name = ''
  form.value = ''
  form.min_trust = 'SACRED'
  formError.value = null
  addOpen.value = true
}

async function onCreate() {
  if (submitting.value || !form.name.trim() || !form.value) return
  submitting.value = true
  formError.value = null
  try {
    await vaultApi.addSecret({ name: form.name.trim(), value: form.value, min_trust: form.min_trust })
    addOpen.value = false
    await loadSecrets()
  } catch (e) {
    formError.value = e.message
  } finally {
    submitting.value = false
  }
}

onMounted(refresh)
</script>

<template>
  <div>
    <PageHeader title="Vault" subtitle="TRUST Protocol — credential broker + KMS">
      <template #actions>
        <button class="glass glass-hover px-3 py-1.5 text-sm text-slate-300" @click="refresh">
          <AppIcon glyph="↻" /> Refresh
        </button>
        <button
          class="rounded-xl bg-brand-gradient px-3 py-1.5 text-sm font-semibold text-white shadow-lg shadow-brand-violet/30 transition-opacity hover:opacity-90"
          @click="openAdd"
        >
          ＋ Add secret
        </button>
      </template>
    </PageHeader>

    <p
      v-if="statusError"
      class="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-300"
    >
      {{ statusError }}
    </p>

    <!-- status banner -->
    <template v-if="status">
      <!-- not configured -->
      <div
        v-if="!status.configured"
        class="mb-6 flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-400"
      >
        <AppIcon glyph="🔒" /> Vault not configured.
      </div>

      <!-- configured but unreachable -->
      <div
        v-else-if="!status.reachable"
        class="mb-6 flex items-center gap-3 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-300"
      >
        <AppIcon glyph="🔒" />
        <span><b>Vault unreachable.</b> Credential operations are unavailable.</span>
      </div>

      <!-- reachable + sealed -->
      <div
        v-else-if="status.sealed"
        class="mb-6 flex items-center gap-3 rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-sm text-amber-300"
      >
        <AppIcon glyph="🔒" />
        <span><b>Vault is sealed</b> — unlock to enable credential operations.</span>
      </div>

      <!-- reachable + unsealed => online -->
      <div v-else class="mb-6 flex flex-wrap items-center gap-2">
        <span class="pill border border-emerald-400/30 bg-emerald-400/10 text-emerald-300">
          <span class="h-2 w-2 rounded-full bg-emerald-400 animate-pulse-dot"></span>
          Vault online
        </span>
        <span v-if="status.url" class="pill border border-white/10 bg-white/5 font-mono text-slate-500">
          {{ status.url }}
        </span>
      </div>
    </template>

    <p
      v-if="error"
      class="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-300"
    >
      {{ error }}
    </p>

    <!-- keys -->
    <section>
      <h2 class="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
        <span class="h-2 w-2 rounded-full bg-violet-400"></span>
        Keys
        <span class="text-slate-600">({{ secrets.length }})</span>
      </h2>
      <p class="mb-3 text-xs text-slate-500">Values are write-only — the vault never returns them.</p>

      <div v-if="secrets.length" class="flex flex-col gap-2">
        <div
          v-for="s in secrets"
          :key="s.name"
          class="glass glass-hover flex flex-wrap items-center gap-3 px-4 py-3"
        >
          <span class="min-w-0 flex-1 truncate font-mono text-sm text-slate-100" :title="s.name">
            <AppIcon glyph="🔒" /> {{ s.name }}
          </span>
          <span class="pill border" :class="tierClass(s.minimum_trust)" :title="'minimum trust: ' + s.minimum_trust">
            {{ s.minimum_trust }}
          </span>
          <span class="pill border border-white/10 bg-white/5 text-slate-400" title="access count">
            {{ s.access_count || 0 }} access{{ (s.access_count || 0) === 1 ? '' : 'es' }}
          </span>
          <button
            type="button"
            class="act-danger"
            :disabled="!!busy[s.name]"
            @click="onDelete(s)"
          >
            <template v-if="busy[s.name] === 'delete'">…</template>
            <template v-else><AppIcon glyph="🗑" /> Delete</template>
          </button>
        </div>
      </div>

      <p v-else class="glass px-4 py-6 text-center text-sm text-slate-500">
        {{ loading ? 'Loading keys…' : 'No vault keys yet — add one above.' }}
      </p>
    </section>

    <!-- add-secret modal -->
    <ModalShell v-if="addOpen" title="Add secret" subtitle="Stored write-only in the vault" @close="addOpen = false">
      <form class="flex flex-col gap-4" @submit.prevent="onCreate">
        <div>
          <label class="mb-1 flex items-center gap-2 text-sm font-medium text-slate-200">
            <span>Key name</span><span class="text-rose-400">*</span>
          </label>
          <input v-model="form.name" type="text" class="field-input font-mono" placeholder="e.g. nextcloud_password" />
        </div>

        <div>
          <label class="mb-1 flex items-center gap-2 text-sm font-medium text-slate-200">
            <span>Value</span><span class="text-rose-400">*</span>
          </label>
          <input v-model="form.value" type="password" class="field-input" placeholder="the secret value" />
          <p class="mt-1 text-xs text-slate-500">Write-only — you won't be able to read this back.</p>
        </div>

        <div>
          <label class="mb-1 block text-sm font-medium text-slate-200">Minimum trust</label>
          <select v-model="form.min_trust" class="field-input">
            <option v-for="t in TIERS" :key="t" :value="t">{{ t }}</option>
          </select>
          <p class="mt-1 text-xs text-slate-500">The lowest trust tier allowed to access this key.</p>
        </div>

        <p
          v-if="formError"
          class="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300"
        >
          {{ formError }}
        </p>
      </form>

      <template #footer>
        <button
          type="button"
          class="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-300 transition-colors hover:bg-white/10"
          @click="addOpen = false"
        >
          Cancel
        </button>
        <button
          type="button"
          :disabled="submitting || !form.name.trim() || !form.value"
          class="rounded-xl bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-brand-violet/30 transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
          @click="onCreate"
        >
          {{ submitting ? 'Adding…' : 'Add secret' }}
        </button>
      </template>
    </ModalShell>
  </div>
</template>

<style scoped>
.act-danger {
  @apply rounded-lg border border-rose-500/20 bg-rose-500/5 px-2.5 py-1 text-xs font-medium text-rose-400/80 transition-colors hover:bg-rose-500/15 disabled:cursor-not-allowed disabled:opacity-50;
}
.field-input {
  @apply w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-100 outline-none transition-colors;
  @apply placeholder:text-slate-600 focus:border-brand-violet/60 focus:bg-white/[0.06];
}
select.field-input option {
  @apply bg-slate-900 text-slate-100;
}
</style>
