<script setup>
// Scans an assistant message for references to local files the agent created (markdown links,
// file:// URIs, or bare absolute/~ paths with an extension), confirms each exists via the core, and
// renders a clickable download chip that streams the artifact through the dashboard.
import { ref, watch } from 'vue'
import { files } from '@/services/api'

const props = defineProps({
  text: { type: String, default: '' },
  streaming: { type: Boolean, default: false }
})

const artifacts = ref([])          // confirmed: [{ path, name, size }]
const checked = new Map()          // path -> {path,name,size} (exists) | false (absent / in-flight)

function extractPaths(text) {
  const out = new Set()
  const t = String(text || '')
  const patterns = [
    /\[[^\]]*\]\(\s*(?:file:\/\/)?((?:~|\/)[^)\s]+?\.[A-Za-z0-9]{1,12})\s*\)/g, // [label](/abs/path.ext)
    /file:\/\/(\/[^\s)'"]+)/g,                                                   // file:///abs/path
    /(?:^|[\s"'`(>])((?:~|\/)[\w./@+\-]+\.[A-Za-z0-9]{1,12})\b/g                 // bare /abs or ~/path.ext
  ]
  for (const rx of patterns) { let m; while ((m = rx.exec(t))) { const p = m[1]; if (p && !/^https?:/i.test(p)) out.add(p) } }
  return [...out]
}

async function refresh() {
  const cands = extractPaths(props.text)
  await Promise.all(cands.map(async (p) => {
    if (checked.has(p)) return
    checked.set(p, false)
    try { const r = await files.stat(p); if (r && r.exists) checked.set(p, { path: p, name: r.name, size: r.size }) } catch (_) {}
  }))
  artifacts.value = cands.map((p) => checked.get(p)).filter(Boolean)
}

// Check once history/text settles; skip mid-stream, then re-check when the stream finishes.
watch(() => props.text, () => { if (!props.streaming) refresh() }, { immediate: true })
watch(() => props.streaming, (s) => { if (!s) refresh() })

function human(n) {
  if (n == null) return ''
  if (n < 1024) return n + ' B'
  if (n < 1048576) return Math.round(n / 1024) + ' KB'
  return (n / 1048576).toFixed(1) + ' MB'
}
const url = files.downloadUrl
</script>

<template>
  <div v-if="artifacts.length" class="mt-1.5 flex flex-wrap gap-1.5">
    <a
      v-for="a in artifacts" :key="a.path"
      :href="url(a.path)" :download="a.name" :title="'Download ' + a.path"
      class="inline-flex items-center gap-1 rounded-md border border-brand-violet/30 bg-brand-violet/10 px-2 py-1 text-[11px] text-violet-200 transition-colors hover:bg-brand-violet/20"
    >⬇ {{ a.name }} <span class="text-slate-400">· {{ human(a.size) }}</span></a>
  </div>
</template>
