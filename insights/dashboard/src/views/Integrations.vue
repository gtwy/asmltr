<script setup>
// Integrations — the connector manager control plane. Three sections:
//   1) Available types (cards from /manager/types) with "+ Add"
//   2) Add/Edit instance (InstanceForm modal, schema-driven)
//   3) Configured instances (InstanceCard grid, live runtime status @ ~3s poll)
import { onMounted, onUnmounted, ref, computed } from 'vue'
import { useManagerStore } from '@/stores/manager'
import PageHeader from '@/components/PageHeader.vue'
import StatTile from '@/components/StatTile.vue'
import InstanceCard from '@/components/InstanceCard.vue'
import InstanceForm from '@/components/InstanceForm.vue'
import LogsModal from '@/components/LogsModal.vue'
import { connectorTypeMeta } from '@/lib/format'

const store = useManagerStore()
const now = ref(Date.now())
let ticker = null

// modal state
const formType = ref(null) // connector type def => InstanceForm open
const formInstance = ref(null) // present => edit mode
const logsInstance = ref(null) // present => LogsModal open

const running = computed(() => store.instances.filter((i) => i.runtime?.status === 'running').length)
const failed = computed(() => store.instances.filter((i) => i.runtime?.status === 'failed').length)

function openAdd(type) {
  formInstance.value = null
  formType.value = type
}

function openEdit(instance) {
  const type = store.typeFor(instance.type)
  if (!type) {
    store.lastError = `No registered type "${instance.type}" — cannot edit.`
    return
  }
  formInstance.value = instance
  formType.value = type
}

function closeForm() {
  formType.value = null
  formInstance.value = null
}

async function onToggle(instance) {
  try {
    await store.setEnabled(instance.id, !instance.enabled)
  } catch {
    /* surfaced via store.lastError */
  }
}

async function onRestart(instance) {
  try {
    await store.restart(instance.id)
  } catch {
    /* surfaced via store.lastError */
  }
}

async function onDelete(instance) {
  if (!window.confirm(`Delete connector "${instance.name}" (${instance.type})?\nThis removes its config permanently.`)) {
    return
  }
  try {
    await store.removeInstance(instance.id)
  } catch (e) {
    store.lastError = e.message
  }
}

onMounted(() => {
  store.fetchTypes()
  store.fetchInstances()
  store.startPolling(3000)
  ticker = setInterval(() => (now.value = Date.now()), 1000)
})
onUnmounted(() => {
  store.stopPolling()
  clearInterval(ticker)
})
</script>

<template>
  <div>
    <PageHeader
      title="Integrations"
      subtitle="Manage comms-channel connector instances — the control plane for the connector platform"
    >
      <template #actions>
        <button
          class="glass glass-hover px-3 py-1.5 text-sm text-slate-300"
          @click="store.fetchInstances()"
        >
          ↻ Refresh
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
      <StatTile label="Connector types" :value="store.types.length" accent="#8B5CF6" />
      <StatTile label="Instances" :value="store.instanceCount" accent="#22D3EE" />
      <StatTile label="Running" :value="running" accent="#34D399" />
      <StatTile label="Failed" :value="failed" accent="#F87171" />
    </div>

    <!-- available types -->
    <section class="mb-8">
      <h2 class="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
        <span class="h-2 w-2 rounded-full bg-violet-400"></span>
        Available connectors
        <span class="text-slate-600">({{ store.types.length }})</span>
      </h2>
      <div
        v-if="store.types.length"
        class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
      >
        <div
          v-for="t in store.types"
          :key="t.type"
          class="glass glass-hover flex flex-col gap-3 p-4"
        >
          <div class="flex items-start justify-between gap-2">
            <span
              class="pill border"
              :style="{
                color: connectorTypeMeta(t.type, t.displayName).color,
                borderColor: connectorTypeMeta(t.type, t.displayName).color + '40',
                backgroundColor: connectorTypeMeta(t.type, t.displayName).color + '1a'
              }"
            >
              {{ connectorTypeMeta(t.type, t.displayName).icon }} {{ t.displayName }}
            </span>
            <span
              v-if="t.supportsMultiple"
              class="pill border border-cyan-400/30 bg-cyan-400/10 text-cyan-300"
              title="multiple instances of this type are allowed"
            >
              multi
            </span>
          </div>

          <div class="flex flex-wrap gap-1.5 text-[11px]">
            <span
              v-for="key in t.credentialKeys"
              :key="key"
              class="pill border border-amber-400/30 bg-amber-400/10 text-amber-300"
              title="required Bitwarden secret key"
            >
              🔑 {{ key }}
            </span>
            <span
              v-if="t.capabilities?.max_message_chars"
              class="pill border border-white/10 bg-white/5 text-slate-400"
            >
              ≤{{ t.capabilities.max_message_chars }} chars
            </span>
          </div>

          <button
            type="button"
            class="mt-auto rounded-xl bg-eve-gradient px-3 py-2 text-sm font-semibold text-white shadow-lg shadow-eve-violet/30 transition-opacity hover:opacity-90"
            @click="openAdd(t)"
          >
            + Add {{ t.displayName }}
          </button>
        </div>
      </div>
      <p v-else class="glass px-4 py-6 text-center text-sm text-slate-500">
        {{ store.loading.types ? 'Loading connector types…' : 'No connector types registered.' }}
      </p>
    </section>

    <!-- configured instances -->
    <section>
      <h2 class="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
        <span class="h-2 w-2 rounded-full bg-emerald-400 animate-pulse-dot"></span>
        Configured instances
        <span class="text-slate-600">({{ store.instanceCount }})</span>
      </h2>
      <div
        v-if="store.instances.length"
        class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
      >
        <InstanceCard
          v-for="inst in store.instances"
          :key="inst.id"
          :instance="inst"
          :busy="store.busy[inst.id] || ''"
          :now="now"
          @toggle="onToggle"
          @restart="onRestart"
          @edit="openEdit"
          @logs="logsInstance = inst"
          @delete="onDelete"
        />
      </div>
      <p v-else class="glass px-4 py-6 text-center text-sm text-slate-500">
        {{ store.loading.instances ? 'Loading instances…' : 'No connectors configured yet — add one above.' }}
      </p>
    </section>

    <!-- modals -->
    <InstanceForm
      v-if="formType"
      :type="formType"
      :instance="formInstance"
      @close="closeForm"
    />
    <LogsModal
      v-if="logsInstance"
      :instance="logsInstance"
      @close="logsInstance = null"
    />
  </div>
</template>
