<script setup>
// Self — proprioception. The live body-schema: my PARTS (active sessions) and how they connect.
// Phase 1a: the structural skeleton (colocated + communicated edges), rendered as a force graph —
// the always-on vital sign, no LLM. The considered self-assessment (deduced goal) lands in 1b.
import { ref, onMounted, onUnmounted, computed } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import BaseChart from '@/components/charts/BaseChart.vue'
import { api } from '@/services/api'
import { surfaceMeta, truncate } from '@/lib/format'

const schema = ref(null)
const loading = ref(true)
let timer = null

async function load() {
  try { schema.value = await api.selfSchema() } catch (_) {} finally { loading.value = false }
}
onMounted(() => { load(); timer = setInterval(load, 15000) })
onUnmounted(() => clearInterval(timer))

const EDGE_COLOR = { colocated: '#8B5CF6', communicated: '#22D3EE', semantic: '#EC4899' }
const EDGE_LABEL = { colocated: 'same repo', communicated: 'announced', semantic: 'related' }

const nodeLabel = (n) => (n.activity && truncate(n.activity, 26)) || (n.title && truncate(n.title, 26)) || n.session_id.split(':').slice(0, 2).join(':')

const option = computed(() => {
  const s = schema.value
  if (!s) return {}
  const surfaces = [...new Set(s.nodes.map((n) => n.surface))]
  const categories = surfaces.map((sf) => ({ name: sf, itemStyle: { color: surfaceMeta(sf).color } }))
  const catIndex = Object.fromEntries(surfaces.map((sf, i) => [sf, i]))
  return {
    tooltip: {
      backgroundColor: 'rgba(15,15,25,0.95)', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, textStyle: { color: '#E2E8F0', fontSize: 12 },
      formatter: (p) => p.dataType === 'edge'
        ? `${EDGE_LABEL[p.data.kind] || p.data.kind}${p.data.detail ? ' · ' + p.data.detail : ''}`
        : `<b>${surfaceMeta(p.data.surface).label}</b><br/>${p.data._activity || ''}<br/><span style="color:#94a3b8">${p.data._repo || p.data.name}</span>`
    },
    legend: [{ data: surfaces.map((sf) => surfaceMeta(sf).label), top: 0, textStyle: { color: '#94A3B8', fontSize: 11 }, icon: 'circle' }],
    series: [{
      type: 'graph', layout: 'force', roam: true, draggable: true,
      label: { show: true, position: 'right', color: '#cbd5e1', fontSize: 10, formatter: (p) => p.data._label },
      lineStyle: { width: 1.5, opacity: 0.7, curveness: 0.08 },
      emphasis: { focus: 'adjacency', lineStyle: { width: 3 } },
      force: { repulsion: 260, edgeLength: [80, 160], gravity: 0.08 },
      categories,
      data: s.nodes.map((n) => ({
        name: n.session_id, category: catIndex[n.surface], surface: n.surface,
        _label: nodeLabel(n), _activity: n.activity || '', _repo: n.repo ? n.repo.split('/').slice(-1)[0] : '',
        symbolSize: Math.min(46, 16 + Math.sqrt(n.tools || 0) * 4 + (n.tokens ? Math.log10(n.tokens + 1) * 3 : 0)),
        itemStyle: { color: surfaceMeta(n.surface).color }
      })),
      links: s.edges.map((e) => ({ source: e.from, target: e.to, kind: e.kind, detail: e.detail, lineStyle: { color: EDGE_COLOR[e.kind] || '#64748b' } }))
    }]
  }
})

const isolated = computed(() => {
  if (!schema.value) return 0
  const connected = new Set()
  for (const e of schema.value.edges) { connected.add(e.from); connected.add(e.to) }
  return schema.value.nodes.filter((n) => !connected.has(n.session_id)).length
})
</script>

<template>
  <div>
    <PageHeader title="Self" subtitle="Proprioception — my parts, and how they connect right now">
      <template #actions>
        <button class="glass glass-hover px-3 py-1.5 text-sm text-slate-300" @click="load">↻ Refresh</button>
      </template>
    </PageHeader>

    <div class="mb-4 flex flex-wrap items-center gap-2 text-[11px]">
      <span class="pill border border-white/10 bg-white/5 text-slate-300">{{ schema?.counts?.parts ?? '—' }} parts</span>
      <span class="pill border border-brand-violet/30 bg-brand-violet/10 text-violet-300">— same repo</span>
      <span class="pill border border-cyan-400/30 bg-cyan-400/10 text-cyan-300">— announced</span>
      <span v-if="isolated" class="pill border border-white/10 bg-white/5 text-slate-500">{{ isolated }} unconnected (relationships are semantic — the reflector will read those)</span>
    </div>

    <div class="glass p-2">
      <p v-if="loading" class="py-16 text-center text-sm text-slate-500">sensing…</p>
      <p v-else-if="!schema?.nodes?.length" class="py-16 text-center text-sm text-slate-500">No parts active right now — the body is at rest.</p>
      <p v-else-if="schema.nodes.length === 1" class="py-16 text-center text-sm text-slate-400">
        One part active: <span class="text-slate-200">{{ nodeLabel(schema.nodes[0]) }}</span>. A single limb — nothing to relate yet.
      </p>
      <BaseChart v-else :option="option" height="560px" />
    </div>

    <p class="mt-4 text-center text-[11px] leading-relaxed text-slate-500">
      Structural edges only (parts in the same repo, or that announced to each other) — the reliable skeleton.
      Meaning-level relationships (what feeds what, what loops back) and the deduced goal come from the self-assessment reflector.
    </p>
  </div>
</template>
