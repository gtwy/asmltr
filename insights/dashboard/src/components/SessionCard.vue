<script setup>
import { computed } from 'vue'
import SurfaceBadge from './SurfaceBadge.vue'
import { statusMeta, fmtAge, fmtNum, truncate } from '@/lib/format'

const props = defineProps({
  session: { type: Object, required: true },
  now: { type: Number, default: () => Date.now() }
})

const st = computed(() => statusMeta(props.session.status))
const age = computed(() => fmtAge(props.session.started_unix, props.now))
const lastSeen = computed(() => fmtAge(props.session.last_activity_unix, props.now))

const muxLabel = computed(() => {
  const m = props.session.multiplexer
  if (!m || m === 'none') return null
  return props.session.tmux_target ? `${m}:${props.session.tmux_target}` : m
})

const claimLabel = computed(() => {
  const c = props.session.claim_state
  if (!c || c === 'free') return null
  return props.session.claimed_by ? `${c} · ${props.session.claimed_by}` : c
})
</script>

<template>
  <div class="glass glass-hover flex flex-col gap-3 p-4">
    <!-- header row -->
    <div class="flex items-start justify-between gap-2">
      <div class="flex flex-wrap items-center gap-2">
        <SurfaceBadge :surface="session.surface" />
        <span
          class="pill border border-white/10 bg-white/5 text-slate-300"
          :title="session.kind === 'persistent' ? 'long-lived daemon' : 'ephemeral session'"
        >
          {{ session.kind }}
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

    <!-- identity / context -->
    <div class="min-w-0">
      <div class="truncate font-mono text-xs text-slate-400" :title="session.session_id">
        {{ session.identity || session.session_id }}
      </div>
      <div
        class="mt-1 text-sm leading-snug text-slate-100"
        :title="session.task || session.context || ''"
      >
        {{ truncate(session.task || session.context || 'no active task', 90) }}
      </div>
      <div
        v-if="session.working_dir"
        class="mt-1 truncate font-mono text-[11px] text-slate-500"
        :title="session.working_dir"
      >
        {{ session.working_dir }}<span v-if="session.worktree"> · wt:{{ session.worktree }}</span>
      </div>
    </div>

    <!-- meta chips -->
    <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
      <span class="pill border border-white/10 bg-white/5 text-slate-300" title="session age">
        ⏱ {{ age }}
      </span>
      <span class="pill border border-white/10 bg-white/5 text-slate-300" title="last activity">
        last {{ lastSeen }}
      </span>
      <span
        class="pill border border-violet-400/30 bg-violet-400/10 text-violet-300"
        title="tokens (attributed)"
      >
        ⟁ {{ fmtNum(session.tokens_total) }} tok
      </span>
      <span
        v-if="session.tool_count"
        class="pill border border-amber-400/30 bg-amber-400/10 text-amber-300"
        title="tool calls"
      >
        🛠 {{ fmtNum(session.tool_count) }}
      </span>
      <span
        v-if="muxLabel"
        class="pill border border-cyan-400/30 bg-cyan-400/10 text-cyan-300"
        title="multiplexer"
      >
        ▣ {{ muxLabel }}
      </span>
      <span
        v-if="claimLabel"
        class="pill border border-pink-400/30 bg-pink-400/10 text-pink-300"
        title="claim state"
      >
        🔒 {{ claimLabel }}
      </span>
      <span
        v-if="session.pid"
        class="pill border border-white/10 bg-white/5 text-slate-500"
        title="process id"
      >
        pid {{ session.pid }}
      </span>
    </div>

    <!-- control plane (disabled stub) -->
    <div class="mt-1 flex items-center justify-end border-t border-white/5 pt-3">
      <button
        type="button"
        disabled
        title="control plane — coming in Phase 4"
        class="cursor-not-allowed rounded-lg border border-rose-500/20 bg-rose-500/5 px-3 py-1 text-xs font-medium text-rose-400/50"
      >
        KILL
      </button>
    </div>
  </div>
</template>
