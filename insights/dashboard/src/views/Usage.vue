<script setup>
import { onMounted, computed } from 'vue'
import { useCollectorStore } from '@/stores/collector'
import { useTrustStore } from '@/stores/trust'
import PageHeader from '@/components/PageHeader.vue'
import BaseChart from '@/components/charts/BaseChart.vue'
import StatTile from '@/components/StatTile.vue'
import { surfaceMeta, fmtNum, fmtUsd } from '@/lib/format'

const store = useCollectorStore()
const trust = useTrustStore()

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
// Two dollar figures: EQUIVALENT value at API rates (all surfaces, incl. subscription) vs BILLED (the
// portion that actually hits a card — API-key surfaces only). Subscription usage shows value but $0 billed.
const totalEquiv = computed(() => store.usage.reduce((s, u) => s + (u.cost_usd || 0), 0))
const totalBilled = computed(() => store.usage.reduce((s, u) => s + (u.billed_cost_usd || 0), 0))
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

// per-user attribution table — grouped by the TRUST PRINCIPAL, not the raw channel identity. A person
// with several linked handles (discord id, email, github login…) in the Access tab folds into one row.
// Unlinked identities fall back to their own (case-normalized) key, so e.g. "moneo"/"Moneo" still merge.
const byIdentity = computed(() => {
  const map = {}
  for (const u of store.usage) {
    const raw = u.identity || ''
    const p = raw ? trust.principalForIdentity(raw) : null
    const key = p ? `p:${p.id}` : (raw ? `i:${raw.toLowerCase()}` : '(unattributed)')
    if (!map[key]) {
      map[key] = {
        key,
        identity: p ? p.display_name : (raw || '(unattributed)'),
        principalId: p ? p.id : null,
        linked: !!p,
        tokens_in: 0, tokens_out: 0, cost_usd: 0, billed_cost_usd: 0, msg_count: 0,
        surfaces: new Set(), handles: new Set(),
      }
    }
    if (raw) map[key].handles.add(raw)
    map[key].tokens_in += u.tokens_in || 0
    map[key].tokens_out += u.tokens_out || 0
    map[key].cost_usd += u.cost_usd || 0
    map[key].billed_cost_usd += u.billed_cost_usd || 0
    map[key].msg_count += u.msg_count || 0
    if (u.surface) map[key].surfaces.add(u.surface)
  }
  return Object.values(map)
    .map((r) => ({ ...r, surfaces: [...r.surfaces], handles: [...r.handles] }))
    .sort((a, b) => b.tokens_in + b.tokens_out - (a.tokens_in + a.tokens_out))
})

const showCostCol = computed(() => byIdentity.value.some((r) => r.cost_usd > 0))

// --- metered aux spend breakdown (tts/stt/moderation) ------------------------------------------------
const auxRows = computed(() => store.usageAux || [])
const hasAux = computed(() => auxRows.value.length > 0)
// Fold the hourly aux buckets into one row per (feature, provider, model, units) for the panel.
const auxBreakdown = computed(() => {
  const map = {}
  for (const a of auxRows.value) {
    const key = `${a.feature}|${a.provider}|${a.model}|${a.units}`
    if (!map[key]) map[key] = { feature: a.feature, provider: a.provider || '—', model: a.model || '—', units: a.units, unit_count: 0, calls: 0, cost_usd: 0, billed_cost_usd: 0 }
    map[key].unit_count += a.unit_count || 0
    map[key].calls += a.calls || 0
    map[key].cost_usd += a.cost_usd || 0
    map[key].billed_cost_usd += a.billed_cost_usd || 0
  }
  return Object.values(map).sort((a, b) => b.cost_usd - a.cost_usd)
})
// Compact unit label: seconds → mm:ss-ish minutes; chars/tokens → k-abbreviated counts.
function fmtUnits(count, units) {
  const n = count || 0
  if (units === 'seconds') return `${(n / 60).toFixed(1)} min`
  if (units === 'chars') return `${fmtNum(n)} chars`
  if (units === 'tokens') return `${fmtNum(n)} tok`
  return fmtNum(n)
}
const FEATURE_LABEL = { tts: 'Text-to-speech', stt: 'Transcription', moderation: 'Moderation', label: 'Labeling' }

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
  // Principals drive the per-user grouping (fold linked channel identities into one person).
  if (!trust.principals.length) trust.fetchPrincipals()
})
</script>

<template>
  <div>
    <PageHeader title="Token usage + attribution" subtitle="Where tokens go, by surface and identity" />

    <!-- framing note -->
    <div class="glass mb-5 flex items-start gap-3 p-3 text-sm">
      <span class="text-lg">ℹ️</span>
      <p class="text-slate-300">
        <span class="font-medium text-white">Two dollar figures.</span>
        <span class="text-emerald-300">Billed</span> = what actually hits a card (metered API keys —
        TTS/STT/moderation, and any API-key engine).
        <span class="text-slate-200">Equivalent value</span> = what the same usage would cost at public API
        rates — computed for <em>everything</em>, including subscription engines (Claude on Max), so you can
        see the value even where you're not charged. Engines that don't report token counts are estimated
        from text length.
      </p>
    </div>

    <div class="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatTile label="Tokens (window)" :value="fmtNum(totalTokens)" accent="#8B5CF6" />
      <StatTile label="Messages" :value="fmtNum(totalMsgs)" accent="#EC4899" />
      <StatTile label="Billed" :value="fmtUsd(totalBilled) || '$0.00'" accent="#34D399" />
      <StatTile label="Equivalent value" :value="fmtUsd(totalEquiv) || '$0.00'" accent="#22D3EE" />
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

    <!-- per-user table (grouped by trust principal) -->
    <div class="glass mt-5 overflow-hidden">
      <h3 class="border-b border-white/10 px-4 py-3 text-sm font-semibold text-slate-300">
        Attribution by user
        <span class="ml-1 font-normal text-slate-500">· linked channel identities are folded into one person (Access tab)</span>
      </h3>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-[11px] uppercase tracking-wider text-slate-500">
              <th class="px-4 py-2 font-medium">User</th>
              <th class="px-4 py-2 font-medium">Surfaces</th>
              <th class="px-4 py-2 text-right font-medium">Tokens in</th>
              <th class="px-4 py-2 text-right font-medium">Tokens out</th>
              <th class="px-4 py-2 text-right font-medium">Msgs</th>
              <th v-if="showCostCol" class="px-4 py-2 text-right font-medium">Billed</th>
              <th v-if="showCostCol" class="px-4 py-2 text-right font-medium">Equiv. value</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="r in byIdentity"
              :key="r.key"
              class="border-t border-white/5 hover:bg-white/[0.03]"
            >
              <td class="px-4 py-2 text-slate-200">
                <span class="font-mono">{{ r.identity }}</span>
                <span v-if="r.linked" class="ml-1 text-[10px] uppercase tracking-wide text-emerald-400/70" title="Linked principal in the Access tab">● linked</span>
                <!-- folded raw handles, shown when a principal groups more than one (or the label differs) -->
                <div
                  v-if="r.handles.length > 1 || (r.handles.length === 1 && r.handles[0] !== r.identity)"
                  class="mt-0.5 font-mono text-[11px] text-slate-500"
                >{{ r.handles.join(' · ') }}</div>
              </td>
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
                {{ r.billed_cost_usd > 0 ? fmtUsd(r.billed_cost_usd) : '—' }}
              </td>
              <td v-if="showCostCol" class="px-4 py-2 text-right font-mono tabular-nums text-cyan-300/80">
                {{ r.cost_usd > 0 ? fmtUsd(r.cost_usd) : '—' }}
              </td>
            </tr>
            <tr v-if="!byIdentity.length">
              <td :colspan="showCostCol ? 7 : 5" class="px-4 py-8 text-center text-slate-500">
                No attribution data yet.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- metered aux spend breakdown (tts / stt / moderation) -->
    <div v-if="hasAux" class="glass mt-5 overflow-hidden">
      <h3 class="border-b border-white/10 px-4 py-3 text-sm font-semibold text-slate-300">
        Metered spend · by feature &amp; provider
        <span class="ml-1 font-normal text-slate-500">· side-surfaces on API keys (voice + moderation) — this is what makes up the Billed total</span>
      </h3>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-[11px] uppercase tracking-wider text-slate-500">
              <th class="px-4 py-2 font-medium">Feature</th>
              <th class="px-4 py-2 font-medium">Provider</th>
              <th class="px-4 py-2 font-medium">Model</th>
              <th class="px-4 py-2 text-right font-medium">Usage</th>
              <th class="px-4 py-2 text-right font-medium">Calls</th>
              <th class="px-4 py-2 text-right font-medium">Billed</th>
              <th class="px-4 py-2 text-right font-medium">Equiv. value</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="a in auxBreakdown" :key="a.feature + a.provider + a.model + a.units" class="border-t border-white/5 hover:bg-white/[0.03]">
              <td class="px-4 py-2 text-slate-200">{{ FEATURE_LABEL[a.feature] || a.feature }}</td>
              <td class="px-4 py-2 capitalize text-slate-300">{{ a.provider }}</td>
              <td class="px-4 py-2 font-mono text-xs text-slate-400">{{ a.model }}</td>
              <td class="px-4 py-2 text-right font-mono tabular-nums text-slate-300">{{ fmtUnits(a.unit_count, a.units) }}</td>
              <td class="px-4 py-2 text-right font-mono tabular-nums text-slate-400">{{ fmtNum(a.calls) }}</td>
              <td class="px-4 py-2 text-right font-mono tabular-nums text-emerald-300">{{ a.billed_cost_usd > 0 ? fmtUsd(a.billed_cost_usd) : '—' }}</td>
              <td class="px-4 py-2 text-right font-mono tabular-nums text-cyan-300/80">{{ a.cost_usd > 0 ? fmtUsd(a.cost_usd) : '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
