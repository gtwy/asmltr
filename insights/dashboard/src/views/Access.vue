<script setup>
// Access — the trust-framework control plane. Manages who can do what across
// every channel. Sections:
//   1) summary tiles (users / active / roles / identifiers)
//   2) Principals — user cards (identifiers + grants), with add/edit/delete and
//      per-card + Identifier / + Grant
//   3) Roles — reusable capability sets, with create/edit/delete
//   4) Resolve preview — "test what someone can do here" (read-only debug tool)
// It pulls identifierFormats from the manager store (connector types) to drive
// the surface pickers, so it fetches manager types alongside trust data.
import { onMounted, computed, ref } from 'vue'
import { useTrustStore } from '@/stores/trust'
import { useManagerStore } from '@/stores/manager'
import PageHeader from '@/components/PageHeader.vue'
import StatTile from '@/components/StatTile.vue'
import PrincipalCard from '@/components/PrincipalCard.vue'
import RoleCard from '@/components/RoleCard.vue'
import PrincipalForm from '@/components/PrincipalForm.vue'
import IdentifierForm from '@/components/IdentifierForm.vue'
import GrantForm from '@/components/GrantForm.vue'
import RoleForm from '@/components/RoleForm.vue'
import ResolvePreview from '@/components/ResolvePreview.vue'

const store = useTrustStore()
const manager = useManagerStore()

// modal state
const principalForm = ref({ open: false, principal: null }) // principal=null => create
const identifierForm = ref(null) // principal => open
const grantForm = ref(null) // principal => open
const roleForm = ref({ open: false, role: null }) // role=null => create

const identifierCount = computed(() =>
  store.principals.reduce((n, p) => n + (p.identifiers?.length || 0), 0)
)

function openAddUser() {
  principalForm.value = { open: true, principal: null }
}
function openEditUser(p) {
  principalForm.value = { open: true, principal: p }
}
function closePrincipalForm() {
  principalForm.value = { open: false, principal: null }
}

function openAddRole() {
  roleForm.value = { open: true, role: null }
}
function openEditRole(r) {
  roleForm.value = { open: true, role: r }
}
function closeRoleForm() {
  roleForm.value = { open: false, role: null }
}

async function deletePrincipal(p) {
  if (!window.confirm(`Delete user "${p.display_name}" (${p.id})?\nThis removes their identifiers and grants permanently.`)) {
    return
  }
  try {
    await store.removePrincipal(p.id)
  } catch (e) {
    store.lastError = e.message
  }
}

async function deleteRole(r) {
  if (!window.confirm(`Delete role "${r.name || r.id}"?\nGrants referencing it will lose their capability set.`)) {
    return
  }
  try {
    await store.removeRole(r.id)
  } catch (e) {
    store.lastError = e.message
  }
}

function refresh() {
  store.fetchPrincipals()
  store.fetchRoles()
}

onMounted(() => {
  // manager types power the identifier/scope surface pickers (identifierFormats)
  if (!manager.types.length) manager.fetchTypes()
  store.fetchPrincipals()
  store.fetchRoles()
})
</script>

<template>
  <div>
    <PageHeader
      title="Access"
      subtitle="Trust framework — users, their cross-channel identities, roles, and capability grants"
    >
      <template #actions>
        <button
          class="glass glass-hover px-3 py-1.5 text-sm text-slate-300"
          @click="refresh"
        >
          ↻ Refresh
        </button>
        <button
          class="rounded-xl bg-brand-gradient px-3 py-1.5 text-sm font-semibold text-white shadow-lg shadow-brand-violet/30 transition-opacity hover:opacity-90"
          @click="openAddUser"
        >
          + Add user
        </button>
      </template>
    </PageHeader>

    <p
      v-if="store.lastError"
      class="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-300"
    >
      {{ store.lastError }}
    </p>

    <!-- summary tiles -->
    <div class="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatTile label="Users" :value="store.principalCount" accent="#8B5CF6" />
      <StatTile label="Active" :value="store.activePrincipalCount" accent="#34D399" />
      <StatTile label="Roles" :value="store.roleCount" accent="#22D3EE" />
      <StatTile label="Identifiers" :value="identifierCount" accent="#EC4899" />
    </div>

    <!-- principals -->
    <section class="mb-8">
      <h2 class="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
        <span class="h-2 w-2 rounded-full bg-violet-400"></span>
        Users
        <span class="text-slate-600">({{ store.principalCount }})</span>
      </h2>
      <div
        v-if="store.principals.length"
        class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
      >
        <PrincipalCard
          v-for="p in store.principals"
          :key="p.id"
          :principal="p"
          :busy="store.busy[p.id] || ''"
          @edit="openEditUser"
          @add-identifier="identifierForm = $event"
          @add-grant="grantForm = $event"
          @delete="deletePrincipal"
        />
      </div>
      <p v-else class="glass px-4 py-6 text-center text-sm text-slate-500">
        {{ store.loading.principals ? 'Loading users…' : 'No users yet — add one above.' }}
      </p>
    </section>

    <!-- roles -->
    <section class="mb-8">
      <h2 class="mb-3 flex items-center justify-between gap-2">
        <span class="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
          <span class="h-2 w-2 rounded-full bg-cyan-400"></span>
          Roles
          <span class="text-slate-600">({{ store.roleCount }})</span>
        </span>
        <button
          type="button"
          class="rounded-lg border border-brand-violet/30 bg-brand-violet/10 px-2.5 py-1 text-xs font-medium text-violet-300 transition-colors hover:bg-brand-violet/20"
          @click="openAddRole"
        >
          + Add role
        </button>
      </h2>
      <div
        v-if="store.roles.length"
        class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
      >
        <RoleCard
          v-for="r in store.roles"
          :key="r.id"
          :role="r"
          @edit="openEditRole"
          @delete="deleteRole"
        />
      </div>
      <p v-else class="glass px-4 py-6 text-center text-sm text-slate-500">
        {{ store.loading.roles ? 'Loading roles…' : 'No roles yet — add one to reuse capability sets across users.' }}
      </p>
    </section>

    <!-- resolve preview -->
    <section>
      <h2 class="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
        <span class="h-2 w-2 rounded-full bg-pink-400"></span>
        Test access
      </h2>
      <ResolvePreview />
    </section>

    <!-- modals -->
    <PrincipalForm
      v-if="principalForm.open"
      :principal="principalForm.principal"
      @close="closePrincipalForm"
    />
    <IdentifierForm
      v-if="identifierForm"
      :principal="identifierForm"
      @close="identifierForm = null"
    />
    <GrantForm
      v-if="grantForm"
      :principal="grantForm"
      @close="grantForm = null"
    />
    <RoleForm
      v-if="roleForm.open"
      :role="roleForm.role"
      @close="closeRoleForm"
    />
  </div>
</template>
