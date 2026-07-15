<script setup>
// Renders every open floating window once, globally (mounted in App). Views just call
// windows.openSession()/openObserver(); this handles stacking, focus, minimize, and the taskbar.
import { ref, onMounted, onUnmounted } from 'vue'
import { useWindows } from '@/stores/windows'
import SessionDetail from './SessionDetail.vue'
import ObserverWindow from './ObserverWindow.vue'

const { state, close, focus, minimize, topId, minimized } = useWindows()

// a slow "now" tick for the session panes' relative-time display
const now = ref(Date.now())
let t = null
onMounted(() => { t = setInterval(() => { now.value = Date.now() }, 30000) })
onUnmounted(() => clearInterval(t))

function label(w) {
  if (w.kind === 'observer') return '🧠 Observer'
  const p = w.payload || {}
  return p.title || p.activity || String(p.session_id || 'session').split(':').slice(0, 2).join(':')
}
</script>

<template>
  <div>
    <template v-for="w in state.list" :key="w.id">
      <SessionDetail
        v-if="w.kind === 'session'"
        :session="w.payload" :now="now" :z="w.z" :focused="topId === w.id" :minimized="w.minimized"
        @close="close(w.id)" @minimize="minimize(w.id)" @focus="focus(w.id)" />
      <ObserverWindow
        v-else
        :z="w.z" :focused="topId === w.id" :minimized="w.minimized"
        @close="close(w.id)" @minimize="minimize(w.id)" @focus="focus(w.id)" />
    </template>

    <!-- taskbar — restore minimized windows -->
    <div v-if="minimized.length" class="fixed bottom-3 left-1/2 z-[95] flex max-w-[92vw] -translate-x-1/2 flex-wrap justify-center gap-2">
      <div v-for="w in minimized" :key="w.id"
           class="glass glass-hover flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs text-slate-200 shadow-lg shadow-black/40">
        <button class="max-w-[200px] truncate" :title="label(w)" @click="focus(w.id)">{{ label(w) }}</button>
        <button class="text-slate-500 hover:text-rose-300" title="Close" @click="close(w.id)">✕</button>
      </div>
    </div>
  </div>
</template>
