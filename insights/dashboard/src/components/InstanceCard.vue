<script setup>
// A SessionCard-styled card for one configured connector instance. Shows a type
// badge, name, live runtime status pill (+ restart count), and the action row:
// enable/disable toggle (start/stop), Restart, Edit, Logs, Delete.
import { computed } from 'vue'
import { connectorTypeMeta, runtimeStatusMeta, fmtAge } from '@/lib/format'

const props = defineProps({
  instance: { type: Object, required: true },
  busy: { type: String, default: '' }, // action in flight for this instance
  now: { type: Number, default: () => Date.now() }
})
const emit = defineEmits(['toggle', 'restart', 'edit', 'logs', 'delete'])

const meta = computed(() => connectorTypeMeta(props.instance.type))
const rt = computed(() => props.instance.runtime || {})
const st = computed(() => runtimeStatusMeta(rt.value.status))
const enabled = computed(() => props.instance.enabled)
const isBusy = computed(() => !!props.busy)

const startedAge = computed(() =>
  rt.value.startedAt ? fmtAge(rt.value.startedAt, props.now) : null
)

// summarize config compactly per known type
const summary = computed(() => {
  const c = props.instance.config || {}
  if (props.instance.type === 'github') {
    const n = Array.isArray(c.repos) ? c.repos.length : 0
    const label = c.trigger_label ? `label:${c.trigger_label}` : null
    return [`${n} repo${n === 1 ? '' : 's'}`, c.dry_run ? 'dry-run' : null, label].filter(Boolean)
  }
  if (props.instance.type === 'telegram') {
    const ids = Array.isArray(c.allowed_chat_ids) ? c.allowed_chat_ids.length : 0
    return [ids ? `${ids} chat${ids === 1 ? '' : 's'}` : 'open', c.http_port ? `:${c.http_port}` : null].filter(Boolean)
  }
  return []
})
</script>

<template>
  <div class="glass glass-hover flex flex-col gap-3 p-4">
    <!-- header -->
    <div class="flex items-start justify-between gap-2">
      <div class="flex min-w-0 flex-wrap items-center gap-2">
        <span
          class="pill border"
          :style="{ color: meta.color, borderColor: meta.color + '40', backgroundColor: meta.color + '1a' }"
        >
          {{ meta.icon }} {{ meta.label }}
        </span>
      </div>
      <div class="flex items-center gap-1.5 text-xs" :style="{ color: st.color }">
        <span
          class="h-2 w-2 rounded-full"
          :class="st.pulse ? 'animate-pulse-dot' : ''"
          :style="{ backgroundColor: st.color }"
        ></span>
        {{ st.label }}
      </div>
    </div>

    <!-- name + context -->
    <div class="min-w-0">
      <div class="truncate text-sm font-semibold text-slate-100" :title="instance.name">
        {{ instance.name }}
      </div>
      <div class="mt-0.5 truncate font-mono text-[11px] text-slate-500" :title="instance.id">
        {{ instance.id }}
      </div>
    </div>

    <!-- meta chips -->
    <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
      <span
        class="pill border"
        :class="enabled
          ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
          : 'border-white/10 bg-white/5 text-slate-400'"
        title="persisted enabled flag"
      >
        {{ enabled ? 'enabled' : 'disabled' }}
      </span>
      <span
        v-if="rt.restarts"
        class="pill border border-amber-400/30 bg-amber-400/10 text-amber-300"
        title="restart count"
      >
        ↻ {{ rt.restarts }} restart{{ rt.restarts === 1 ? '' : 's' }}
      </span>
      <span
        v-if="rt.pid"
        class="pill border border-white/10 bg-white/5 text-slate-500"
        title="process id"
      >
        pid {{ rt.pid }}
      </span>
      <span
        v-if="startedAge"
        class="pill border border-white/10 bg-white/5 text-slate-400"
        title="uptime"
      >
        ⏱ {{ startedAge }}
      </span>
      <span
        v-for="chip in summary"
        :key="chip"
        class="pill border border-violet-400/30 bg-violet-400/10 text-violet-300"
      >
        {{ chip }}
      </span>
      <span
        v-if="rt.lastExit != null && rt.status === 'failed'"
        class="pill border border-rose-500/30 bg-rose-500/10 text-rose-300"
        title="last exit code"
      >
        exit {{ rt.lastExit }}
      </span>
    </div>

    <!-- action row -->
    <div class="mt-1 flex flex-wrap items-center gap-2 border-t border-white/5 pt-3">
      <!-- enable/disable -->
      <button
        type="button"
        role="switch"
        :aria-checked="enabled"
        :disabled="isBusy"
        title="enable / disable (start / stop)"
        class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50"
        :class="enabled ? 'bg-brand-gradient' : 'bg-white/10'"
        @click="emit('toggle', instance)"
      >
        <span
          class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform"
          :class="enabled ? 'translate-x-6' : 'translate-x-1'"
        ></span>
      </button>

      <button type="button" class="act" :disabled="isBusy" @click="emit('restart', instance)">
        {{ busy === 'restart' ? '↻…' : '↻ Restart' }}
      </button>
      <button type="button" class="act" :disabled="isBusy" @click="emit('edit', instance)">✎ Edit</button>
      <button type="button" class="act" :disabled="isBusy" @click="emit('logs', instance)">▤ Logs</button>
      <button
        type="button"
        class="act-danger ml-auto"
        :disabled="isBusy"
        @click="emit('delete', instance)"
      >
        {{ busy === 'delete' ? '…' : '🗑 Delete' }}
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
</style>
