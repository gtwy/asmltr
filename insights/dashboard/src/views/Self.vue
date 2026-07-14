<script setup>
// Self — proprioception. Two layers of self-knowledge over one body:
//   • the always-on SKELETON (1a): my PARTS (active sessions) + structural wiring (same-repo,
//     announced-to), a force graph, no LLM.
//   • the considered VOICE (1b): a slow reflector deducing the goal / threads / flags / semantic
//     edges over that skeleton.
// The graph only RE-LAYS-OUT when the body's topology changes (a part joins/leaves, an edge
// appears) — live activity/token churn updates the HTML panels but must not reflow the graph
// (that was jarring). Clicking a part opens its chat (the same SessionDetail pane as Live).
import { ref, onMounted, onUnmounted, computed } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import BaseChart from '@/components/charts/BaseChart.vue'
import SessionDetail from '@/components/SessionDetail.vue'
import { useCollectorStore } from '@/stores/collector'
import { api } from '@/services/api'
import { surfaceMeta, truncate, fmtAge, fmtNum } from '@/lib/format'

const store = useCollectorStore()
const schema = ref(null)          // polled live — drives the HTML panels (goal, list, counts)
const assessment = ref(null)      // { latest, history }
const graphData = ref(null)       // topology SNAPSHOT for the chart — only replaced on a real change
const loading = ref(true)
const now = ref(Date.now())
const selected = ref(null)        // clicked part → opens the chat pane
let timer = null
let lastTopoSig = ''

// Depth of field for the body — how far back a part can have acted and still count as "present".
const WINDOWS = [
  { key: '1h', label: '1h', ms: 3600000 },
  { key: '6h', label: '6h', ms: 6 * 3600000 },
  { key: '24h', label: '24h', ms: 24 * 3600000 },
  { key: '3d', label: '3d', ms: 72 * 3600000 }
]
const windowKey = ref('24h')
const windowMs = computed(() => (WINDOWS.find((w) => w.key === windowKey.value) || WINDOWS[2]).ms)

const nodes = computed(() => schema.value?.nodes || [])
const latest = computed(() => assessment.value?.latest || null)

// Semantic edges from the reflector, kept only where BOTH endpoints are currently present.
function semEdgesOf(sch, assess) {
  const rels = assess?.latest?.relations
  if (!rels || !sch) return []
  const present = new Set(sch.nodes.map((n) => n.session_id))
  return rels.filter((r) => present.has(r.from) && present.has(r.to))
}
const semanticEdges = computed(() => semEdgesOf(schema.value, assessment.value))

// A signature of the body's SHAPE only (which parts, which edges) — NOT their live activity/load.
// The graph snapshot is refreshed only when this changes, so idle polls don't reflow the layout.
function topoSig(sch, sem) {
  return [
    sch.nodes.map((n) => n.session_id).sort().join(','),
    (sch.edges || []).map((e) => `${e.from}>${e.to}:${e.kind}`).sort().join(','),
    sem.map((e) => `${e.from}>${e.to}:${e.rel}`).sort().join(',')
  ].join('|')
}
function syncGraph() {
  if (!schema.value) return
  const sem = semanticEdges.value
  const sig = topoSig(schema.value, sem)
  if (sig === lastTopoSig) return       // same shape → leave the graph (and its layout) untouched
  lastTopoSig = sig
  graphData.value = { nodes: schema.value.nodes, edges: schema.value.edges || [], semantic: sem }
}

async function load() {
  try {
    now.value = Date.now()
    const since = now.value - windowMs.value
    const [s, a] = await Promise.all([api.selfSchema({ since }), api.selfAssessment().catch(() => null)])
    schema.value = s
    assessment.value = a
    syncGraph()
  } catch (_) {} finally { loading.value = false }
}
function setWindow(k) { windowKey.value = k; lastTopoSig = ''; loading.value = true; load() } // new window → new body
onMounted(() => { load(); store.fetchSessions?.(); timer = setInterval(load, 15000) })
onUnmounted(() => clearInterval(timer))

const EDGE_COLOR = { colocated: '#8B5CF6', communicated: '#22D3EE' }
const REL_COLOR = '#EC4899'
const nodeLabel = (n) => (n.activity && truncate(n.activity, 26)) || (n.title && truncate(n.title, 26)) || n.session_id.split(':').slice(0, 2).join(':')

// Body at a glance — surface breakdown + live repos + total load, from the live (polled) node set.
const surfaces = computed(() => {
  const m = {}
  for (const n of nodes.value) m[n.surface] = (m[n.surface] || 0) + 1
  return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([s, c]) => ({ surface: s, count: c, meta: surfaceMeta(s) }))
})
const repos = computed(() => [...new Set(nodes.value.map((n) => n.repo).filter(Boolean).map((r) => r.split('/').slice(-1)[0]))])
const totals = computed(() => nodes.value.reduce((a, n) => ({ tokens: a.tokens + (n.tokens || 0), tools: a.tools + (n.tools || 0) }), { tokens: 0, tools: 0 }))
const isolated = computed(() => {
  const connected = new Set()
  for (const e of schema.value?.edges || []) { connected.add(e.from); connected.add(e.to) }
  for (const e of semanticEdges.value) { connected.add(e.from); connected.add(e.to) }
  return nodes.value.filter((n) => !connected.has(n.session_id)).length
})

// The chart option is built from the topology SNAPSHOT (graphData), so it only changes on reshape.
const option = computed(() => {
  const g = graphData.value
  if (!g || !g.nodes.length) return {}
  const surfaceList = [...new Set(g.nodes.map((n) => n.surface))]
  const categories = surfaceList.map((sf) => ({ name: surfaceMeta(sf).label, itemStyle: { color: surfaceMeta(sf).color } }))
  const catIndex = Object.fromEntries(surfaceList.map((sf, i) => [sf, i]))
  const structural = g.edges.map((e) => ({
    source: e.from, target: e.to, kind: e.kind, detail: e.detail,
    lineStyle: { color: EDGE_COLOR[e.kind] || '#64748b', width: 1.5, opacity: 0.7, curveness: 0.08 }
  }))
  const semantic = g.semantic.map((e) => ({
    source: e.from, target: e.to, kind: 'semantic', detail: e.rel,
    lineStyle: { color: REL_COLOR, width: 2, opacity: 0.85, type: 'dashed', curveness: 0.18 },
    label: { show: true, formatter: e.rel, color: '#f9a8d4', fontSize: 9 }
  }))
  return {
    tooltip: {
      backgroundColor: 'rgba(15,15,25,0.95)', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, textStyle: { color: '#E2E8F0', fontSize: 12 },
      formatter: (p) => p.dataType === 'edge'
        ? `${p.data.kind === 'semantic' ? '✦ ' + p.data.detail : (p.data.kind === 'colocated' ? 'same repo' : 'announced')}${p.data.kind !== 'semantic' && p.data.detail ? ' · ' + p.data.detail : ''}`
        : `<b>${surfaceMeta(p.data.surface).label}</b><br/>${p.data._activity || '(idle)'}<br/><span style="color:#94a3b8">${p.data._repo || ''} ${p.data._age}</span><br/><span style="color:#64748b">click to open chat</span>`
    },
    legend: [{ data: categories.map((c) => c.name), top: 0, textStyle: { color: '#94A3B8', fontSize: 11 }, icon: 'circle' }],
    animationDurationUpdate: 0,   // no re-tween on data merge — only the initial layout animates
    series: [{
      type: 'graph', layout: 'force', roam: true, draggable: true,
      label: { show: true, position: 'right', color: '#cbd5e1', fontSize: 10, formatter: (p) => p.data._label },
      emphasis: { focus: 'adjacency', lineStyle: { width: 4 }, label: { fontSize: 11 } },
      force: { repulsion: 320, edgeLength: [90, 180], gravity: 0.06, friction: 0.3 },
      categories,
      data: g.nodes.map((n) => ({
        name: n.session_id, category: catIndex[n.surface], surface: n.surface,
        _label: nodeLabel(n), _activity: n.activity || n.title || '', _repo: n.repo ? n.repo.split('/').slice(-1)[0] : '',
        _age: n.age_min <= 1 ? 'active now' : `${n.age_min}m ago`,
        symbolSize: Math.min(52, 18 + Math.sqrt(n.tools || 0) * 4 + (n.tokens ? Math.log10(n.tokens + 1) * 3 : 0)),
        cursor: 'pointer',
        itemStyle: { color: surfaceMeta(n.surface).color, opacity: n.age_min > 30 ? 0.45 : 1, borderColor: 'rgba(255,255,255,0.25)', borderWidth: 1 }
      })),
      links: [...structural, ...semantic]
    }]
  }
})

// Click a part → open its chat (web sessions stream through the core; channel sessions inject).
function openPart(sid) {
  if (!sid) return
  const node = nodes.value.find((n) => n.session_id === sid)
  selected.value = node ? { ...node } : { session_id: sid }
  store.fetchSessions?.() // freshen so SessionDetail live-merges the real collector row
}
function onGraphClick(p) {
  if (!p || p.dataType !== 'node') return
  openPart(p.data?.name || p.name)
}
</script>

<template>
  <div>
    <PageHeader title="Self" subtitle="Proprioception — my parts, what connects them, and what I seem to be working toward">
      <template #actions>
        <div class="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 p-0.5">
          <button v-for="w in WINDOWS" :key="w.key" class="rounded-md px-2 py-1 text-xs transition"
                  :class="windowKey === w.key ? 'bg-brand-violet/30 text-violet-200' : 'text-slate-400 hover:text-slate-200'"
                  @click="setWindow(w.key)">{{ w.label }}</button>
        </div>
        <button class="glass glass-hover px-3 py-1.5 text-sm text-slate-300" @click="load">↻</button>
      </template>
    </PageHeader>

    <!-- 1b: the deduced goal — the considered voice, laid over the skeleton -->
    <div class="glass mb-4 overflow-hidden p-4">
      <div class="flex items-center justify-between gap-3">
        <span class="text-[11px] font-medium uppercase tracking-wider text-slate-500">Deduced goal</span>
        <span v-if="latest" class="text-[11px] text-slate-500">reflected {{ fmtAge(latest.ts) }} · {{ latest.parts }} parts</span>
      </div>
      <p v-if="latest?.goal" class="mt-1.5 text-lg leading-snug text-slate-100">{{ latest.goal }}</p>
      <p v-else-if="!latest" class="mt-1.5 text-sm italic text-slate-500">
        No reflection yet — the considered pass runs on a slow heartbeat (needs ≥2 parts working at once).
        The live skeleton below is always on.
      </p>
      <p v-else class="mt-1.5 text-sm italic text-slate-500">The parts look unrelated right now — no single goal to deduce.</p>

      <div v-if="latest && (latest.threads?.length || latest.flags?.length)" class="mt-3 flex flex-wrap gap-1.5">
        <span v-for="(t, i) in latest.threads" :key="'t' + i" class="pill border border-white/10 bg-white/5 text-[11px] text-slate-300">{{ t }}</span>
        <span v-for="(f, i) in latest.flags" :key="'f' + i" class="pill border border-amber-400/30 bg-amber-400/10 text-[11px] text-amber-300">⚠ {{ f }}</span>
      </div>
    </div>

    <!-- body at a glance -->
    <div class="mb-4 flex flex-wrap items-center gap-2 text-[11px]">
      <span class="pill border border-white/10 bg-white/5 text-slate-200">{{ nodes.length }} parts active</span>
      <span v-if="schema?.counts?.resting" class="pill border border-white/10 bg-white/5 text-slate-500">{{ schema.counts.resting }} resting beyond window</span>
      <span v-for="s in surfaces" :key="s.surface" class="pill border text-[11px]"
            :style="{ borderColor: s.meta.color + '55', color: s.meta.color }">{{ s.meta.label }} ×{{ s.count }}</span>
      <span v-if="repos.length" class="pill border border-white/10 bg-white/5 text-slate-400">repos: {{ repos.join(', ') }}</span>
      <span v-if="totals.tokens" class="pill border border-white/10 bg-white/5 text-slate-400">{{ fmtNum(totals.tokens) }} tok · {{ totals.tools }} tools</span>
    </div>

    <div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <!-- the body-schema graph -->
      <div class="glass p-2 lg:col-span-2">
        <p v-if="loading && !graphData" class="py-24 text-center text-sm text-slate-500">sensing…</p>
        <p v-else-if="!nodes.length" class="py-24 text-center text-sm text-slate-500">No parts active in this window — the body is at rest.</p>
        <p v-else-if="nodes.length === 1" class="py-24 text-center text-sm text-slate-400">
          One part active: <button class="text-slate-200 underline decoration-dotted hover:text-white" @click="openPart(nodes[0].session_id)">{{ nodeLabel(nodes[0]) }}</button>. A single limb — nothing to relate yet.
        </p>
        <BaseChart v-else :option="option" height="560px" @click="onGraphClick" />
      </div>

      <!-- the parts, listed — click to open the chat -->
      <div class="glass flex flex-col p-3">
        <div class="mb-2 flex items-center justify-between">
          <span class="text-[11px] font-medium uppercase tracking-wider text-slate-500">Parts</span>
          <span class="text-[11px] text-slate-600">click to open</span>
        </div>
        <div class="flex-1 space-y-1.5 overflow-y-auto" style="max-height: 560px">
          <p v-if="!nodes.length" class="py-8 text-center text-xs text-slate-600">—</p>
          <button v-for="n in nodes" :key="n.session_id" type="button"
                  class="w-full rounded-lg border border-white/5 bg-white/[0.02] p-2 text-left transition hover:border-brand-violet/40 hover:bg-white/[0.06]"
                  :class="n.age_min > 30 ? 'opacity-60' : ''" @click="openPart(n.session_id)">
            <div class="flex items-center gap-2">
              <span class="h-2 w-2 flex-none rounded-full" :style="{ background: surfaceMeta(n.surface).color }"></span>
              <span class="truncate text-xs text-slate-200">{{ nodeLabel(n) }}</span>
            </div>
            <div class="mt-0.5 flex items-center gap-2 pl-4 text-[10px] text-slate-500">
              <span>{{ surfaceMeta(n.surface).label }}</span>
              <span v-if="n.repo">· {{ n.repo.split('/').slice(-1)[0] }}</span>
              <span>· {{ n.age_min <= 1 ? 'now' : n.age_min + 'm' }}</span>
            </div>
          </button>
        </div>
        <div v-if="isolated" class="mt-2 border-t border-white/5 pt-2 text-[10px] leading-relaxed text-slate-600">
          {{ isolated }} unconnected — not unrelated, just no structural or deduced link yet.
        </div>
      </div>
    </div>

    <!-- legend + how goal has shifted -->
    <div class="mt-4 flex flex-wrap items-center justify-between gap-3">
      <div class="flex flex-wrap items-center gap-2 text-[11px]">
        <span class="pill border border-brand-violet/30 bg-brand-violet/10 text-violet-300">— same repo</span>
        <span class="pill border border-cyan-400/30 bg-cyan-400/10 text-cyan-300">— announced</span>
        <span class="pill border border-pink-400/30 bg-pink-400/10 text-pink-300">╌ semantic (feeds / duplicates / loops-back)</span>
      </div>
      <details v-if="assessment?.history?.length > 1" class="text-[11px] text-slate-500">
        <summary class="cursor-pointer hover:text-slate-300">goal over time</summary>
        <ul class="mt-1.5 space-y-0.5">
          <li v-for="h in assessment.history" :key="h.id" class="flex gap-2">
            <span class="w-14 flex-none text-slate-600">{{ fmtAge(h.ts) }}</span>
            <span class="text-slate-400">{{ h.goal || '—' }}</span>
          </li>
        </ul>
      </details>
    </div>

    <!-- clicked part → the same chat pane as Live (web streams via core; channel = inject) -->
    <SessionDetail v-if="selected" :session="selected" :now="now" @close="selected = null" />
  </div>
</template>
