<script setup>
import { onMounted, onUnmounted, computed } from 'vue'
import { useRoute } from 'vue-router'
import { useCollectorStore } from '@/stores/collector'
import { NAV_ROUTES } from '@/router'

const store = useCollectorStore()
const route = useRoute()

const navItems = NAV_ROUTES

const statusText = computed(() => (store.connected ? 'live' : 'offline'))

onMounted(() => {
  store.connectSocket()
  store.startPolling()
  // prime shared data so any landing route has something to show
  store.fetchSessions()
  store.fetchBrief()
})

onUnmounted(() => {
  store.stopPolling()
})
</script>

<template>
  <div class="flex min-h-screen flex-col lg:flex-row">
    <!-- Sidebar (desktop) / top brand (mobile) -->
    <aside
      class="lg:sticky lg:top-0 lg:h-screen lg:w-60 lg:shrink-0 lg:border-r lg:border-white/10 lg:bg-black/20 lg:backdrop-blur-xl"
    >
      <div class="flex items-center justify-between px-4 py-4 lg:flex-col lg:items-stretch lg:gap-6">
        <!-- Brand -->
        <div class="flex items-center gap-3">
          <div class="h-9 w-9 rounded-2xl bg-brand-gradient shadow-lg shadow-brand-violet/30"></div>
          <div class="leading-tight">
            <div class="text-sm font-bold tracking-tight">
              <span class="gradient-text">asmltr</span> insights
            </div>
            <div class="text-[11px] text-slate-400">observability plane</div>
          </div>
        </div>

        <!-- Connection pill (mobile, inline) -->
        <div class="flex items-center gap-2 lg:hidden">
          <span
            class="h-2 w-2 rounded-full"
            :class="store.connected ? 'bg-emerald-400 animate-pulse-dot' : 'bg-rose-500'"
          ></span>
          <span class="text-xs text-slate-400">{{ statusText }}</span>
        </div>
      </div>

      <!-- Nav -->
      <nav
        class="flex gap-1 overflow-x-auto border-t border-white/10 px-2 py-2 lg:flex-col lg:overflow-visible lg:border-0 lg:px-3"
      >
        <RouterLink
          v-for="item in navItems"
          :key="item.name"
          :to="item.path"
          class="group flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-white/5"
          :class="route.name === item.name ? 'bg-white/[0.07] text-white gradient-border' : ''"
        >
          <span
            class="text-base"
            :class="route.name === item.name ? 'gradient-text' : 'text-slate-500 group-hover:text-slate-300'"
            >{{ item.meta.icon }}</span
          >
          <span class="whitespace-nowrap">{{ item.meta.title }}</span>
        </RouterLink>
      </nav>

      <!-- Connection pill (desktop, bottom) -->
      <div class="hidden lg:absolute lg:bottom-0 lg:left-0 lg:right-0 lg:block lg:px-4 lg:py-4">
        <div class="glass flex items-center justify-between px-3 py-2">
          <div class="flex items-center gap-2">
            <span
              class="h-2 w-2 rounded-full"
              :class="store.connected ? 'bg-emerald-400 animate-pulse-dot' : 'bg-rose-500'"
            ></span>
            <span class="text-xs text-slate-300">collector {{ statusText }}</span>
          </div>
          <span class="text-[11px] text-slate-500">:3017</span>
        </div>
        <p v-if="store.lastError" class="mt-2 truncate text-[10px] text-rose-400/80" :title="store.lastError">
          {{ store.lastError }}
        </p>
      </div>
    </aside>

    <!-- Main -->
    <main class="min-w-0 flex-1 px-4 py-5 lg:px-8 lg:py-7">
      <RouterView v-slot="{ Component }">
        <Transition name="fade" mode="out-in">
          <component :is="Component" />
        </Transition>
      </RouterView>
    </main>
  </div>
</template>
