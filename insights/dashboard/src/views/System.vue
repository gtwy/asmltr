<script setup>
import { onMounted, computed } from 'vue'
import { useCollectorStore } from '@/stores/collector'
import PageHeader from '@/components/PageHeader.vue'
import BaseChart from '@/components/charts/BaseChart.vue'
import StatTile from '@/components/StatTile.vue'

const store = useCollectorStore()

const AXIS_COLOR = '#475569'
const SPLIT_COLOR = 'rgba(148,163,184,0.08)'

const latest = computed(() => store.latestSample)
const memRatio = computed(() =>
  latest.value && latest.value.mem_total_mb
    ? latest.value.mem_used_mb / latest.value.mem_total_mb
    : null
)
const swapRatio = computed(() =>
  latest.value && latest.value.swap_total_mb
    ? latest.value.swap_used_mb / latest.value.swap_total_mb
    : null
)

const times = computed(() =>
  store.samples.map((s) => new Date(s.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
)

function tooltipStyle() {
  return {
    backgroundColor: 'rgba(15,15,25,0.95)',
    borderColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1,
    textStyle: { color: '#E2E8F0', fontSize: 12 }
  }
}

function lineOption(series, { max, percent } = {}) {
  return {
    grid: { left: 8, right: 16, top: 28, bottom: 8, containLabel: true },
    legend: { top: 0, textStyle: { color: '#94A3B8', fontSize: 11 }, icon: 'roundRect' },
    tooltip: { trigger: 'axis', ...tooltipStyle() },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: times.value,
      axisLine: { lineStyle: { color: AXIS_COLOR } },
      axisLabel: { color: '#94A3B8', fontSize: 10 }
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: max ?? null,
      axisLabel: {
        color: '#94A3B8',
        fontSize: 11,
        formatter: percent ? '{value}%' : '{value}'
      },
      splitLine: { lineStyle: { color: SPLIT_COLOR } }
    },
    series
  }
}

function area(name, key, color) {
  return {
    name,
    type: 'line',
    smooth: true,
    showSymbol: false,
    lineStyle: { width: 2, color },
    itemStyle: { color },
    areaStyle: {
      color: {
        type: 'linear',
        x: 0, y: 0, x2: 0, y2: 1,
        colorStops: [
          { offset: 0, color: color + '55' },
          { offset: 1, color: color + '05' }
        ]
      }
    },
    data: store.samples.map((s) => s[key])
  }
}

const cpuOption = computed(() => lineOption([area('CPU %', 'cpu_pct', '#8B5CF6')], { max: 100, percent: true }))
const loadOption = computed(() =>
  lineOption([
    { name: 'load1', type: 'line', smooth: true, showSymbol: false, lineStyle: { color: '#EC4899', width: 2 }, itemStyle: { color: '#EC4899' }, data: store.samples.map((s) => s.load1) },
    { name: 'load5', type: 'line', smooth: true, showSymbol: false, lineStyle: { color: '#22D3EE', width: 2 }, itemStyle: { color: '#22D3EE' }, data: store.samples.map((s) => s.load5) }
  ])
)
const memOption = computed(() =>
  lineOption(
    [
      area('mem used (MB)', 'mem_used_mb', '#34D399'),
      {
        name: 'mem total (MB)',
        type: 'line',
        smooth: true,
        showSymbol: false,
        lineStyle: { color: '#64748B', width: 1, type: 'dashed' },
        itemStyle: { color: '#64748B' },
        data: store.samples.map((s) => s.mem_total_mb)
      }
    ]
  )
)
const diskOption = computed(() => lineOption([area('disk used %', 'disk_used_pct', '#F59E0B')], { max: 100, percent: true }))

onMounted(() => {
  store.fetchSystem()
})
</script>

<template>
  <div>
    <PageHeader title="System" subtitle="Host telemetry · live-updating from the sampler">
      <template #actions>
        <span class="text-xs text-slate-500">{{ store.samples.length }} samples</span>
      </template>
    </PageHeader>

    <!-- big stat tiles -->
    <div class="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
      <StatTile
        label="CPU"
        :value="latest ? latest.cpu_pct.toFixed(0) : '—'"
        unit="%"
        accent="#8B5CF6"
        :ratio="latest ? latest.cpu_pct / 100 : null"
        :sub="latest ? `load ${latest.load1?.toFixed(2)} / ${latest.load5?.toFixed(2)}` : ''"
      />
      <StatTile
        label="Memory"
        :value="latest ? (latest.mem_used_mb / 1024).toFixed(1) : '—'"
        unit="GB"
        accent="#34D399"
        :ratio="memRatio"
        :sub="latest ? `of ${(latest.mem_total_mb / 1024).toFixed(1)} GB` : ''"
      />
      <StatTile
        label="Swap"
        :value="latest ? (latest.swap_used_mb / 1024).toFixed(1) : '—'"
        unit="GB"
        accent="#38BDF8"
        :ratio="swapRatio"
        :sub="latest ? (latest.swap_total_mb ? `of ${(latest.swap_total_mb / 1024).toFixed(1)} GB` : 'no swap') : ''"
      />
      <StatTile
        label="Disk used"
        :value="latest ? latest.disk_used_pct.toFixed(0) : '—'"
        unit="%"
        accent="#F59E0B"
        :ratio="latest ? latest.disk_used_pct / 100 : null"
      />
      <StatTile
        label="Disk free"
        :value="latest ? latest.disk_free_gb.toFixed(1) : '—'"
        unit="GB"
        accent="#22D3EE"
      />
    </div>

    <div class="grid grid-cols-1 gap-5 xl:grid-cols-2">
      <div class="glass p-4">
        <h3 class="mb-2 text-sm font-semibold text-slate-300">CPU %</h3>
        <BaseChart v-if="store.samples.length" :option="cpuOption" height="240px" />
        <p v-else class="py-10 text-center text-sm text-slate-500">No samples yet.</p>
      </div>
      <div class="glass p-4">
        <h3 class="mb-2 text-sm font-semibold text-slate-300">Load average (1m / 5m)</h3>
        <BaseChart v-if="store.samples.length" :option="loadOption" height="240px" />
        <p v-else class="py-10 text-center text-sm text-slate-500">No samples yet.</p>
      </div>
      <div class="glass p-4">
        <h3 class="mb-2 text-sm font-semibold text-slate-300">Memory (MB)</h3>
        <BaseChart v-if="store.samples.length" :option="memOption" height="240px" />
        <p v-else class="py-10 text-center text-sm text-slate-500">No samples yet.</p>
      </div>
      <div class="glass p-4">
        <h3 class="mb-2 text-sm font-semibold text-slate-300">Disk used %</h3>
        <BaseChart v-if="store.samples.length" :option="diskOption" height="240px" />
        <p v-else class="py-10 text-center text-sm text-slate-500">No samples yet.</p>
      </div>
    </div>
  </div>
</template>
