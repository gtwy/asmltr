<script setup>
import { onMounted } from 'vue'
import { useCollectorStore } from '@/stores/collector'
import PageHeader from '@/components/PageHeader.vue'
import SurfaceBadge from '@/components/SurfaceBadge.vue'
import { fmtDateTime } from '@/lib/format'

const store = useCollectorStore()

onMounted(() => {
  store.fetchNotifications()
})
</script>

<template>
  <div>
    <PageHeader title="Notifications" subtitle="Outbound alerts the assistant has surfaced">
      <template #actions>
        <button
          class="glass glass-hover px-3 py-1.5 text-sm text-slate-300"
          @click="store.fetchNotifications()"
        >
          <AppIcon glyph="↻" /> Refresh
        </button>
      </template>
    </PageHeader>

    <div v-if="store.notifications.length" class="flex flex-col gap-3">
      <article
        v-for="(n, i) in store.notifications"
        :key="n.ts + '-' + i"
        class="glass glass-hover p-4"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="flex flex-wrap items-center gap-2">
            <SurfaceBadge v-if="n.surface" :surface="n.surface" />
            <span v-if="n.channel" class="pill border border-white/10 bg-white/5 text-slate-300">
              {{ n.channel }}
            </span>
          </div>
          <time class="shrink-0 font-mono text-[11px] text-slate-500">{{ fmtDateTime(n.ts) }}</time>
        </div>
        <h3 v-if="n.title" class="mt-2 font-semibold text-white">{{ n.title }}</h3>
        <p v-if="n.body" class="mt-1 whitespace-pre-wrap text-sm text-slate-300">{{ n.body }}</p>
        <p v-if="n.session_id" class="mt-2 truncate font-mono text-[11px] text-slate-600">
          {{ n.session_id }}
        </p>
      </article>
    </div>

    <div v-else class="glass px-4 py-12 text-center">
      <div class="mb-2 text-3xl opacity-50"><AppIcon glyph="✦" /></div>
      <p class="text-sm text-slate-400">
        {{ store.loading.notifications ? 'Loading…' : 'No notifications recorded yet.' }}
      </p>
    </div>
  </div>
</template>
