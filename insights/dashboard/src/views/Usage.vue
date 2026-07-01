<script setup>
import { onMounted, computed } from 'vue'
import { useCollectorStore } from '@/stores/collector'
import PageHeader from '@/components/PageHeader.vue'
import BaseChart from '@/components/charts/BaseChart.vue'
import StatTile from '@/components/StatTile.vue'
import { surfaceMeta, fmtNum, fmtUsd } from '@/lib/format'

const store = useCollectorStore()

const AXIS_COLOR = '#475569'
const SPLIT_COLOR = 'rgba(148,163,184,0.08)'

const surfaces = computed(() =>
  [...new Set(store.usage.map((u) => u.surface).filter(Boolean))].sort()
)

const buckets = computed(() =>
  [...new Set(store.usage.map((u) => u.bucket_hour))].sort((a, b) => a - b)
)

const totalTokens = computed(() =>
  store.usage.reduce((s, u) => s + (u.tokens_in || 0) + (u.tokens_out || 0), 0)
)
const totalCost = computed(() => store.usage.reduce((s, u) => s + (u.cost_usd || 0), 0))
const totalMsgs = computed(() => store.usage.reduce((s, u) => s + (u.msg_count || 0), 0))

// stacked area: tokens per surface over the hourly buckets
const areaOption = computed(() => {
  const x = buckets.value.map((b) =>
    new Date(b).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit' })
  )
  const series = surfaces.value.map((surface) => {
    const data = buckets.value.map((b) => {
      const row = store.usage.find((u) => u.bucket_hour === b && u.surface === surface)
      return row ? (row.tokens_in || 0) + (row.tokens_out || 0) : 0
    })
    const color = surfaceMeta(surface).color
    return {
      name: surfaceMeta(surface).label,
      type: 'line',
      stack: 'tok',
      smooth: true,
      showSymbol: false,
      areaStyle: { opacity: 0.25, color },
      lineStyle: { width: 2, color },
      itemStyle: { color },
      data
    }
  })
  return baseOption(x, series)
})

// bar: total tokens by surface
const barOption = computed(() => {
  const totals = surfaces.value.map((surface) =>
    store.usage
      .filter((u) => u.surface === surface)
      .reduce((s, u) => s + (u.tokens_in || 0) + (u.tokens_out || 0), 0)
  )
  return {
    grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, ...tooltipStyle() },
    xAxis: {
      type: 'category',
      data: surfaces.value.map((s) => surfaceMeta(s).label),
      axisLine: { lineStyle: { color: AXIS_COLOR } },
      axisLabel: { color: '#94A3B8', fontSize: 11 }
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#94A3B8', fontSize: 11, formatter: (v) => fmtNum(v) },
      splitLine: { lineStyle: { color: SPLIT_COLOR } }
    },
    series: [
      {
        type: 'bar',
        data: surfaces.value.map((s, i) => ({
          value: totals[i],
          itemStyle: { color: surfaceMeta(s).color, borderRadius: [6, 6, 0, 0] }
        })),
        barMaxWidth: 48
      }
    ]
  }
})

// per-identity attribution table
const byIdentity = computed(() => {
  const map = {}
  for (const u of store.usage) {
    const key = u.identity || '(unattributed)'
    if (!map[key]) map[key] = { identity: key, tokens_in: 0, tokens_out: 0, cost_usd: 0, msg_count: 0, surfaces: new Set() }
    map[key].tokens_in += u.tokens_in || 0
    map[key].tokens_out += u.tokens_out || 0
    map[key].cost_usd += u.cost_usd || 0
    map[key].msg_count += u.msg_count || 0
    if (u.surface) map[key].surfaces.add(u.surface)
  }
  return Object.values(map)
    .map((r) => ({ ...r, surfaces: [...r.surfaces] }))
    .sort((a, b) => b.tokens_in + b.tokens_out - (a.tokens_in + a.tokens_out))
})

const showCostCol = computed(() => byIdentity.value.some((r) => r.cost_usd > 0))

function tooltipStyle() {
  return {
    backgroundColor: 'rgba(15,15,25,0.95)',
    borderColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1,
    textStyle: { color: '#E2E8F0', fontSize: 12 }
  }
}

function baseOption(xData, series) {
  return {
    grid: { left: 8, right: 16, top: 36, bottom: 8, containLabel: true },
    legend: { top: 0, textStyle: { color: '#94A3B8', fontSize: 11 }, icon: 'roundRect' },
    tooltip: { trigger: 'axis', ...tooltipStyle() },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: xData,
      axisLine: { lineStyle: { color: AXIS_COLOR } },
      axisLabel: { color: '#94A3B8', fontSize: 10 }
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#94A3B8', fontSize: 11, formatter: (v) => fmtNum(v) },
      splitLine: { lineStyle: { color: SPLIT_COLOR } }
    },
    series
  }
}

onMounted(() => {
  store.fetchUsage()
})
</script>

<template>
  <div>
    <PageHeader title="Token usage + attribution" subtitle="Where Eve's tokens go, by surface and identity" />

    <!-- framing note -->
    <div class="glass mb-5 flex items-start gap-3 p-3 text-sm">
      <span class="text-lg">ℹ️</span>
      <p class="text-slate-300">
        <span class="font-medium text-white">Max-plan surfaces: usage is attributed, not billed.</span>
        Token counts reflect activity attribution; a
        <code class="rounded bg-white/10 px-1 text-xs">$</code> figure only appears where the
        collector recorded a real cost.
      </p>
    </div>

    <div class="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
      <StatTile label="Tokens (window)" :value="fmtNum(totalTokens)" accent="#8B5CF6" />
      <StatTile label="Messages" :value="fmtNum(totalMsgs)" accent="#EC4899" />
      <StatTile
        v-if="totalCost > 0"
        label="Attributed cost"
        :value="fmtUsd(totalCost) || '$0'"
        accent="#34D399"
      />
    </div>

    <div class="grid grid-cols-1 gap-5 xl:grid-cols-2">
      <div class="glass p-4">
        <h3 class="mb-2 text-sm font-semibold text-slate-300">Tokens over time · by surface</h3>
        <BaseChart v-if="store.usage.length" :option="areaOption" height="300px" />
        <p v-else class="py-10 text-center text-sm text-slate-500">No usage data yet.</p>
      </div>

      <div class="glass p-4">
        <h3 class="mb-2 text-sm font-semibold text-slate-300">Total tokens · by surface</h3>
        <BaseChart v-if="store.usage.length" :option="barOption" height="300px" />
        <p v-else class="py-10 text-center text-sm text-slate-500">No usage data yet.</p>
      </div>
    </div>

    <!-- identity table -->
    <div class="glass mt-5 overflow-hidden">
      <h3 class="border-b border-white/10 px-4 py-3 text-sm font-semibold text-slate-300">
        Attribution by identity
      </h3>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-[11px] uppercase tracking-wider text-slate-500">
              <th class="px-4 py-2 font-medium">Identity</th>
              <th class="px-4 py-2 font-medium">Surfaces</th>
              <th class="px-4 py-2 text-right font-medium">Tokens in</th>
              <th class="px-4 py-2 text-right font-medium">Tokens out</th>
              <th class="px-4 py-2 text-right font-medium">Msgs</th>
              <th v-if="showCostCol" class="px-4 py-2 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="r in byIdentity"
              :key="r.identity"
              class="border-t border-white/5 hover:bg-white/[0.03]"
            >
              <td class="px-4 py-2 font-mono text-slate-200">{{ r.identity }}</td>
              <td class="px-4 py-2">
                <div class="flex flex-wrap gap-1">
                  <span
                    v-for="s in r.surfaces"
                    :key="s"
                    class="pill border"
                    :style="{
                      color: surfaceMeta(s).color,
                      borderColor: surfaceMeta(s).color + '30',
                      backgroundColor: surfaceMeta(s).color + '12'
                    }"
                    >{{ surfaceMeta(s).label }}</span
                  >
                </div>
              </td>
              <td class="px-4 py-2 text-right font-mono tabular-nums text-slate-300">{{ fmtNum(r.tokens_in) }}</td>
              <td class="px-4 py-2 text-right font-mono tabular-nums text-slate-300">{{ fmtNum(r.tokens_out) }}</td>
              <td class="px-4 py-2 text-right font-mono tabular-nums text-slate-400">{{ fmtNum(r.msg_count) }}</td>
              <td v-if="showCostCol" class="px-4 py-2 text-right font-mono tabular-nums text-emerald-300">
                {{ r.cost_usd > 0 ? fmtUsd(r.cost_usd) : '—' }}
              </td>
            </tr>
            <tr v-if="!byIdentity.length">
              <td :colspan="showCostCol ? 6 : 5" class="px-4 py-8 text-center text-slate-500">
                No attribution data yet.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
