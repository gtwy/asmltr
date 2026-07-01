<script setup>
// Thin wrapper around vue-echarts with only the renderers/components we use
// registered, so the bundle stays small.
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { LineChart, BarChart } from 'echarts/charts'
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent
} from 'echarts/components'
import VChart from 'vue-echarts'

use([
  CanvasRenderer,
  LineChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent
])

defineProps({
  option: { type: Object, required: true },
  height: { type: String, default: '280px' }
})
</script>

<template>
  <VChart
    class="w-full"
    :style="{ height }"
    :option="option"
    autoresize
    :theme="undefined"
  />
</template>
