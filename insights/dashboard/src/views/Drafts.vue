<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { drafts as draftsApi } from '@/services/api'
import PageHeader from '@/components/PageHeader.vue'
import SurfaceBadge from '@/components/SurfaceBadge.vue'
import { fmtDateTime } from '@/lib/format'

const items = ref([])
const loading = ref(false)
const error = ref(null)
const busy = ref(null) // id currently being approved/discarded
let timer = null

async function load() {
  loading.value = true
  try { items.value = (await draftsApi.list('pending')).drafts || []; error.value = null }
  catch (e) { error.value = e.message }
  finally { loading.value = false }
}
async function approve(d) {
  busy.value = d.id
  try { await draftsApi.approve(d.id); items.value = items.value.filter((x) => x.id !== d.id) }
  catch (e) { error.value = e.message }
  finally { busy.value = null }
}
async function discard(d) {
  busy.value = d.id
  try { await draftsApi.discard(d.id); items.value = items.value.filter((x) => x.id !== d.id) }
  catch (e) { error.value = e.message }
  finally { busy.value = null }
}

onMounted(() => { load(); timer = setInterval(load, 15000) })
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div>
    <PageHeader title="Drafts" subtitle="Replies held for your approval before they go out">
      <template #actions>
        <button class="glass glass-hover px-3 py-1.5 text-sm text-slate-300" @click="load()"><AppIcon glyph="↻" /> Refresh</button>
      </template>
    </PageHeader>

    <p v-if="error" class="glass mb-3 px-4 py-2 text-sm text-rose-300">{{ error }}</p>

    <div v-if="items.length" class="flex flex-col gap-3">
      <article v-for="d in items" :key="d.id" class="glass p-4">
        <div class="flex items-start justify-between gap-3">
          <div class="flex flex-wrap items-center gap-2">
            <SurfaceBadge v-if="d.channel" :surface="d.channel" />
            <span class="pill border border-white/10 bg-white/5 text-slate-300">→ {{ d.recipient || '?' }}</span>
            <span v-if="d.subject" class="text-sm font-semibold text-white">{{ d.subject }}</span>
          </div>
          <time class="shrink-0 font-mono text-[11px] text-slate-500">{{ fmtDateTime(d.created_at) }}</time>
        </div>

        <p class="mt-2 whitespace-pre-wrap text-sm text-slate-300">{{ d.body }}</p>

        <div v-if="d.attachments && d.attachments.length" class="mt-2 font-mono text-[11px] text-slate-500">
          <AppIcon glyph="📎" /> {{ d.attachments.length }} attachment(s)
        </div>
        <p v-if="d.reason" class="mt-2 font-mono text-[11px] text-slate-600">held: {{ d.reason }}</p>

        <div class="mt-3 flex gap-2">
          <button
            class="rounded bg-emerald-500/20 px-3 py-1.5 text-sm text-emerald-200 hover:bg-emerald-500/30 disabled:opacity-40"
            :disabled="busy === d.id" @click="approve(d)"
          ><template v-if="busy === d.id">…</template><template v-else><AppIcon glyph="✓" /> Approve & send</template></button>
          <button
            class="rounded bg-white/5 px-3 py-1.5 text-sm text-slate-300 hover:bg-white/10 disabled:opacity-40"
            :disabled="busy === d.id" @click="discard(d)"
          >Discard</button>
        </div>
      </article>
    </div>

    <div v-else class="glass px-4 py-12 text-center">
      <div class="mb-2 text-3xl opacity-50"><AppIcon glyph="✎" /></div>
      <p class="text-sm text-slate-400">{{ loading ? 'Loading…' : 'No drafts awaiting approval.' }}</p>
    </div>
  </div>
</template>
