<script setup>
// A glass card for one principal (trust-framework user). Shows display name +
// id, default tier, a REVOKED badge when revoked, the user's identifiers
// (surface badge + value, each removable) and grants (role name or "inline" +
// optional scope label, each removable). Action row: Edit, + Identifier,
// + Grant, Delete. Mutations are emitted up to the Access view / handled via the
// trust store for removals.
import { computed } from 'vue'
import { useTrustStore } from '@/stores/trust'
import { surfaceMeta } from '@/lib/format'

const props = defineProps({
  principal: { type: Object, required: true },
  busy: { type: String, default: '' }
})
const emit = defineEmits(['edit', 'add-identifier', 'add-grant', 'delete', 'merge'])

const store = useTrustStore()
const p = computed(() => props.principal)
const isBusy = computed(() => !!props.busy)

const identifiers = computed(() => p.value.identifiers || [])
const grants = computed(() => p.value.grants || [])

function grantLabel(g) {
  if (g.role_id) return store.roleName(g.role_id)
  return 'inline'
}
function scopeLabel(g) {
  if (!g.scope_surface && !g.scope_id) return null
  if (g.scope_surface && g.scope_id) return `${g.scope_surface}:${g.scope_id}`
  return g.scope_surface || g.scope_id
}
function grantCounts(g) {
  // for inline grants, summarize counts; for role grants the role holds them
  const a = (g.allow || []).length
  const r = (g.requires_approval || []).length
  const f = (g.forbidden || []).length
  return { a, r, f }
}

function idMeta(surface) {
  return surfaceMeta(surface)
}

async function removeIdentifier(iid) {
  if (!window.confirm('Remove this identifier?')) return
  try {
    await store.removeIdentifier(iid)
  } catch (e) {
    store.lastError = e.message
  }
}
async function removeGrant(gid) {
  if (!window.confirm('Remove this grant?')) return
  try {
    await store.removeGrant(gid)
  } catch (e) {
    store.lastError = e.message
  }
}
</script>

<template>
  <div class="glass glass-hover flex flex-col gap-3 p-4" :class="p.revoked ? 'opacity-75' : ''">
    <!-- header -->
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <span class="truncate text-sm font-semibold text-slate-100" :title="p.display_name">
            {{ p.display_name }}
          </span>
          <span
            v-if="p.revoked"
            class="pill border border-rose-500/40 bg-rose-500/15 text-rose-300"
            title="access revoked"
          >
            revoked
          </span>
        </div>
        <div class="mt-0.5 truncate font-mono text-[11px] text-slate-500" :title="p.id">{{ p.id }}</div>
      </div>
      <span
        class="pill border border-violet-400/30 bg-violet-400/10 text-violet-300"
        title="default trust tier (lower = more trusted)"
      >
        tier {{ p.default_tier }}
      </span>
    </div>

    <p v-if="p.notes" class="line-clamp-2 text-xs text-slate-400" :title="p.notes">{{ p.notes }}</p>

    <!-- identifiers -->
    <div>
      <div class="mb-1 flex items-center justify-between">
        <span class="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Identifiers</span>
        <button type="button" class="link-btn" :disabled="isBusy" @click="emit('add-identifier', p)">
          + Identifier
        </button>
      </div>
      <div v-if="identifiers.length" class="flex flex-wrap gap-1.5">
        <span
          v-for="id in identifiers"
          :key="id.id"
          class="pill border"
          :style="{
            color: idMeta(id.surface).color,
            borderColor: idMeta(id.surface).color + '40',
            backgroundColor: idMeta(id.surface).color + '1a'
          }"
          :title="`${id.surface}: ${id.value}`"
        >
          <AppIcon :glyph="idMeta(id.surface).icon" aria-hidden="true" />
          <span class="font-mono text-[11px]">{{ id.value }}</span>
          <button
            type="button"
            class="ml-1 text-[10px] opacity-70 transition-opacity hover:opacity-100"
            :aria-label="`remove identifier ${id.value}`"
            @click="removeIdentifier(id.id)"
          >
            <AppIcon glyph="✕" />
          </button>
        </span>
      </div>
      <p v-else class="text-xs text-slate-600">No identifiers — this user can't be matched to a channel yet.</p>
    </div>

    <!-- grants -->
    <div>
      <div class="mb-1 flex items-center justify-between">
        <span class="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Grants</span>
        <button type="button" class="link-btn" :disabled="isBusy" @click="emit('add-grant', p)">
          + Grant
        </button>
      </div>
      <div v-if="grants.length" class="flex flex-col gap-1.5">
        <div
          v-for="g in grants"
          :key="g.id"
          class="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5"
        >
          <span
            class="pill border"
            :class="g.role_id
              ? 'border-cyan-400/30 bg-cyan-400/10 text-cyan-300'
              : 'border-violet-400/30 bg-violet-400/10 text-violet-300'"
          >
            {{ grantLabel(g) }}
          </span>
          <span
            v-if="scopeLabel(g)"
            class="pill border border-white/10 bg-white/5 font-mono text-[11px] text-slate-400"
            title="scope"
          >
            @ {{ scopeLabel(g) }}
          </span>
          <template v-if="!g.role_id">
            <span v-if="grantCounts(g).a" class="text-[11px] text-emerald-300/80">{{ grantCounts(g).a }} allow</span>
            <span v-if="grantCounts(g).r" class="text-[11px] text-amber-300/80">{{ grantCounts(g).r }} appr</span>
            <span v-if="grantCounts(g).f" class="text-[11px] text-rose-300/80">{{ grantCounts(g).f }} forbid</span>
          </template>
          <span v-if="g.bypass_moderation" class="text-[11px] text-pink-300/80" title="bypasses moderation"><AppIcon glyph="⚡" />bypass</span>
          <span v-if="g.strict_mode" class="text-[11px] text-slate-400" title="strict mode"><AppIcon glyph="🔒" />strict</span>
          <button
            type="button"
            class="ml-auto shrink-0 rounded-md border border-rose-500/20 bg-rose-500/5 px-1.5 py-0.5 text-[10px] text-rose-400/80 transition-colors hover:bg-rose-500/15"
            :aria-label="`remove grant ${g.id}`"
            @click="removeGrant(g.id)"
          >
            <AppIcon glyph="✕" />
          </button>
        </div>
      </div>
      <p v-else class="text-xs text-slate-600">No grants — falls back to default tier permissions.</p>
    </div>

    <!-- action row -->
    <div class="mt-1 flex flex-wrap items-center gap-2 border-t border-white/5 pt-3">
      <button type="button" class="act" :disabled="isBusy" @click="emit('edit', p)"><AppIcon glyph="✎" /> Edit</button>
      <button type="button" class="act" :disabled="isBusy" title="Merge this user into another (combine split records)" @click="emit('merge', p)">
        {{ busy === 'merge' ? '…' : '⤵ Merge' }}
      </button>
      <button
        type="button"
        class="act-danger ml-auto"
        :disabled="isBusy"
        @click="emit('delete', p)"
      >
        <template v-if="busy === 'delete'">…</template><template v-else><AppIcon glyph="🗑" /> Delete</template>
      </button>
    </div>
  </div>
</template>

<style scoped>
.act {
  @apply rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-medium text-slate-300 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50;
}
.act-danger {
  @apply rounded-lg border border-rose-500/20 bg-rose-500/5 px-2.5 py-1 text-xs font-medium text-rose-400/80 transition-colors hover:bg-rose-500/15 disabled:cursor-not-allowed disabled:opacity-50;
}
.link-btn {
  @apply rounded-md border border-brand-violet/30 bg-brand-violet/10 px-2 py-0.5 text-[11px] font-medium text-violet-300 transition-colors hover:bg-brand-violet/20 disabled:cursor-not-allowed disabled:opacity-50;
}
</style>
