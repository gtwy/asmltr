<script setup>
// Remote Desktop — the registry of every host machine registered with the WebRTC signaling broker (the
// remote-desktop connector). Lists each host's name, capabilities (video/audio/control) and online
// state, auto-refreshing. From a host row you can "Cast to my phone": push an open-remote-desktop
// directive to a connected android device so its app opens that host's live stream.
//
// The broker is TOKEN-gated (a token → trust identity; view to list, full trust to cast). The token is
// device-local (like the mobile RD viewer) — set it once here and it's kept in localStorage.
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import Spinner from '@/components/Spinner.vue'
import { rd } from '@/services/api'

const hosts = ref([])
const devices = ref([])
const canCast = ref(false)
const loading = ref(false)
const error = ref('')
const notice = ref('')
const token = ref(rd.getToken())
const tokenInput = ref('')
const castTarget = ref('')         // '' = every connected device of mine
const castControl = reactive({})   // host_id -> want input control
const casting = ref('')            // host_id with a cast in flight
let timer = null

const hasToken = computed(() => !!token.value)

function capBits(h) {
  const bits = []
  if (h.caps && h.caps.video !== false) bits.push('video')
  if (h.caps && h.caps.audio) bits.push('audio')
  if (h.caps && h.caps.control) bits.push('control')
  return bits
}

async function refresh() {
  if (!hasToken.value) return
  loading.value = true
  try {
    const r = await rd.list()
    hosts.value = r.hosts || []
    error.value = ''
    try { const d = await rd.devices(); devices.value = d.devices || []; canCast.value = !!d.can_cast } catch { /* device list optional */ }
  } catch (e) {
    error.value = e.message
  } finally { loading.value = false }
}

function saveToken() {
  const t = tokenInput.value.trim(); if (!t) return
  rd.setToken(t); token.value = t; tokenInput.value = ''
  refresh()
}
function clearToken() { rd.setToken(''); token.value = ''; hosts.value = []; devices.value = []; error.value = '' }

async function cast(h) {
  casting.value = h.host_id; notice.value = ''
  const control = !!castControl[h.host_id] && !!(h.caps && h.caps.control)
  try {
    const r = await rd.cast(castTarget.value, h.host_id, control)
    notice.value = r.delivered
      ? `Cast “${h.name || h.host_id}” to ${r.delivered} device${r.delivered === 1 ? '' : 's'}${control ? ' with control' : ''}.`
      : 'No connected device received it (open the app on your phone, then cast).'
  } catch (e) { notice.value = '✗ ' + e.message }
  finally { casting.value = ''; setTimeout(() => (notice.value = ''), 6000) }
}

onMounted(() => {
  refresh()
  // Auto-refresh the registry; pause when the tab is hidden to avoid pointless polling.
  timer = setInterval(() => { if (hasToken.value && document.visibilityState !== 'hidden') refresh() }, 5000)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div>
    <PageHeader title="Remote Desktop" subtitle="Registered host machines — view or cast to a device">
      <template #actions>
        <button
          class="glass glass-hover px-3 py-1.5 text-sm text-slate-300 disabled:opacity-40"
          :disabled="!hasToken || loading"
          @click="refresh"
        >
          <Spinner v-if="loading" size="xs" class="mr-1" /><AppIcon v-else glyph="↻" /> Refresh
        </button>
      </template>
    </PageHeader>

    <!-- Token gate: the broker authenticates by an RD token (→ trust identity). Kept device-local. -->
    <div v-if="!hasToken" class="glass mx-auto max-w-xl p-6">
      <h3 class="mb-1 text-sm font-semibold text-slate-200">Connect to the signaling broker</h3>
      <p class="mb-4 text-[13px] leading-relaxed text-slate-400">
        The remote-desktop broker is token-gated. Paste an RD token (from the broker's keys file — the
        same token → trust identity convention as the phone app). It's stored on this device only. A
        <b class="text-violet-300">full-trust</b> token is required to cast a host to a device.
      </p>
      <div class="flex items-center gap-2">
        <input
          v-model="tokenInput" type="password" autocomplete="off" placeholder="RD broker token"
          class="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 font-mono text-xs text-slate-100 outline-none focus:border-brand-violet/60"
          @keydown.enter.prevent="saveToken"
        />
        <button
          type="button" :disabled="!tokenInput.trim()"
          class="shrink-0 rounded-lg bg-brand-gradient px-4 py-2 text-xs font-semibold text-white disabled:opacity-40"
          @click="saveToken"
        >Connect</button>
      </div>
    </div>

    <template v-else>
      <!-- cast target + connection controls -->
      <div class="glass mb-4 flex flex-wrap items-center gap-3 p-4">
        <div class="min-w-0">
          <div class="text-[11px] uppercase tracking-wide text-slate-500">Cast target</div>
          <select
            v-model="castTarget"
            class="mt-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-brand-violet/60"
          >
            <option value="">All my devices</option>
            <option v-for="d in devices" :key="d.id" :value="d.id">{{ d.name || d.id }}</option>
          </select>
        </div>
        <span v-if="!canCast" class="pill border border-amber-400/30 bg-amber-400/10 text-[10px] text-amber-300">
          view-only token — casting needs full trust
        </span>
        <span class="ml-auto flex items-center gap-2">
          <span class="pill border border-white/10 bg-white/5 text-[10px] text-slate-400">🔒 token stored on this device</span>
          <button type="button" class="text-xs text-slate-500 hover:text-slate-300" @click="clearToken">change</button>
        </span>
      </div>

      <p v-if="notice" class="glass mb-3 px-4 py-2 text-[13px] text-violet-200">{{ notice }}</p>
      <p v-if="error" class="mb-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-[13px] text-rose-300">{{ error }}</p>

      <!-- host registry -->
      <div v-if="hosts.length" class="flex flex-col gap-3">
        <article v-for="h in hosts" :key="h.host_id" class="glass glass-hover p-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <span class="relative flex h-2.5 w-2.5 shrink-0">
                  <span v-if="h.online" class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/60"></span>
                  <span class="relative inline-flex h-2.5 w-2.5 rounded-full" :class="h.online ? 'bg-emerald-400' : 'bg-slate-600'"></span>
                </span>
                <h3 class="truncate font-semibold text-white">{{ h.name || h.host_id }}</h3>
              </div>
              <p class="mt-0.5 truncate font-mono text-[11px] text-slate-600">{{ h.host_id }}</p>
              <div class="mt-2 flex flex-wrap gap-1.5">
                <span
                  v-for="c in capBits(h)" :key="c"
                  class="pill border border-white/10 bg-white/5 text-[10px] text-slate-300"
                >{{ c }}</span>
                <span
                  class="pill border text-[10px]"
                  :class="h.online ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' : 'border-white/10 bg-white/5 text-slate-500'"
                >{{ h.online ? '● online' : '○ offline' }}</span>
              </div>
            </div>

            <div class="flex shrink-0 flex-col items-end gap-2">
              <button
                type="button"
                :disabled="!canCast || casting === h.host_id"
                class="rounded-lg bg-brand-gradient px-4 py-1.5 text-xs font-semibold text-white shadow-lg shadow-brand-violet/30 disabled:opacity-40"
                @click="cast(h)"
              >
                <Spinner v-if="casting === h.host_id" size="xs" class="mr-1" />
                <AppIcon v-else glyph="📲" class="mr-1" />Cast to {{ castTarget ? 'device' : 'my phone' }}
              </button>
              <label
                v-if="h.caps && h.caps.control && canCast"
                class="flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-400"
              >
                <input v-model="castControl[h.host_id]" type="checkbox" class="accent-brand-violet" />
                with input control
              </label>
            </div>
          </div>
        </article>
      </div>

      <div v-else class="glass px-4 py-12 text-center">
        <div class="mb-2 text-3xl opacity-50"><AppIcon glyph="🖥" /></div>
        <p class="text-sm text-slate-400">
          {{ loading ? 'Discovering hosts…' : 'No hosts registered. Start a host agent, then refresh.' }}
        </p>
      </div>
    </template>
  </div>
</template>
