<script setup>
// In-browser recorder (roadmap §B, issue #110). Capture audio with MediaRecorder — record/pause/resume/
// stop, an elapsed timer + live level meter, an optional title, and a timestamp/TAG button that drops a
// marker at the current offset. On stop it uploads the blob to /v2/recordings (which transcribes +
// enriches), then PATCHes the title + markers. Emits `saved(id)` so the parent refreshes + selects it.
import { ref, computed, onBeforeUnmount } from 'vue'
import { recordingsApi } from '@/services/api'

const emit = defineEmits(['saved'])
const state = ref('idle') // idle | recording | paused | saving
const title = ref('')
const elapsed = ref(0)          // ms
const level = ref(0)            // 0..1 live mic level
const markers = ref([])         // [{ t_sec, label }]
const error = ref(null)

let media = null, rec = null, chunks = [], stream = null
let audioCtx = null, analyser = null, raf = null
let t0 = 0, acc = 0, tick = null

const mmss = (ms) => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` }
const elapsedSec = computed(() => elapsed.value / 1000)

function meter() {
  if (!analyser) return
  const buf = new Uint8Array(analyser.fftSize); analyser.getByteTimeDomainData(buf)
  let s = 0; for (let i = 0; i < buf.length; i++) { const d = (buf[i] - 128) / 128; s += d * d }
  level.value = Math.min(1, Math.sqrt(s / buf.length) * 4)
  raf = requestAnimationFrame(meter)
}
function startTimer() { t0 = performance.now(); tick = setInterval(() => { elapsed.value = acc + (performance.now() - t0) }, 200) }
function stopTimer() { if (tick) clearInterval(tick); tick = null; acc = elapsed.value }

async function start() {
  error.value = null
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    analyser = audioCtx.createAnalyser(); analyser.fftSize = 512
    audioCtx.createMediaStreamSource(stream).connect(analyser); meter()
    chunks = []; rec = new MediaRecorder(stream)
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data) }
    rec.start(1000)
    acc = 0; elapsed.value = 0; markers.value = []; startTimer(); state.value = 'recording'
  } catch (e) { error.value = 'Mic: ' + e.message }
}
function pause() { if (rec && state.value === 'recording') { rec.pause(); stopTimer(); state.value = 'paused' } }
function resume() { if (rec && state.value === 'paused') { rec.resume(); startTimer(); state.value = 'recording' } }
function tag() { markers.value.push({ t_sec: Math.round(elapsedSec.value), label: '' }) }

function cleanup() {
  stopTimer(); if (raf) cancelAnimationFrame(raf); raf = null
  try { stream && stream.getTracks().forEach((t) => t.stop()) } catch (_) {}
  try { audioCtx && audioCtx.close() } catch (_) {}
  analyser = null; level.value = 0
}

async function stopAndSave() {
  if (!rec) return
  state.value = 'saving'
  const done = new Promise((res) => { rec.onstop = res })
  rec.stop(); await done
  cleanup()
  const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
  try {
    const r = await recordingsApi.upload(blob, { source: 'recorder', title: title.value || 'Recording' })
    const patch = {}
    if (title.value.trim()) patch.title = title.value.trim()
    if (markers.value.length) patch.markers = markers.value
    if (Object.keys(patch).length) await recordingsApi.patch(r.id, patch)
    title.value = ''; markers.value = []; elapsed.value = 0; state.value = 'idle'
    emit('saved', r.id)
  } catch (e) { error.value = e.message; state.value = 'idle' }
}
function discard() { if (rec) { try { rec.onstop = () => {} ; rec.stop() } catch (_) {} } cleanup(); state.value = 'idle'; elapsed.value = 0; markers.value = [] }

onBeforeUnmount(cleanup)
</script>

<template>
  <div class="rounded-2xl border border-white/10 bg-white/[0.03] p-4 mb-4">
    <div class="flex items-center gap-3 flex-wrap">
      <!-- record button / state -->
      <button v-if="state === 'idle'" class="md-tap px-3 py-2 rounded-xl text-sm font-semibold text-white flex items-center gap-2"
              :style="{ background: 'linear-gradient(120deg, rgb(var(--brand-violet)), rgb(var(--brand-pink)))' }" @click="start">
        <font-awesome-icon :icon="['fas','microphone']" /> Record
      </button>
      <template v-else>
        <span class="relative flex items-center gap-2 text-sm font-mono tabular-nums">
          <span class="w-2.5 h-2.5 rounded-full" :class="state === 'recording' ? 'bg-rose-400 animate-pulse' : 'bg-amber-400'"></span>
          {{ mmss(elapsed) }}
        </span>
        <!-- level meter -->
        <span class="h-2 w-24 rounded-full bg-white/10 overflow-hidden"><span class="block h-full" :style="{ width: (level*100)+'%', background: 'rgb(var(--brand-violet))', transition: 'width .08s' }"></span></span>
        <button v-if="state === 'recording'" class="text-xs px-2.5 py-1.5 rounded-lg bg-white/5 hover:bg-white/10" @click="pause"><font-awesome-icon :icon="['fas','stop']" class="opacity-0 w-0"/>Pause</button>
        <button v-if="state === 'paused'" class="text-xs px-2.5 py-1.5 rounded-lg bg-white/5 hover:bg-white/10" @click="resume">Resume</button>
        <button class="text-xs px-2.5 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 flex items-center gap-1" :disabled="state==='saving'" @click="tag">＋ Tag</button>
        <button class="text-xs px-2.5 py-1.5 rounded-lg text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/20 font-semibold" :disabled="state==='saving'" @click="stopAndSave">{{ state === 'saving' ? 'Saving…' : 'Stop & save' }}</button>
        <button class="text-xs px-2.5 py-1.5 rounded-lg text-rose-300 bg-rose-500/10 hover:bg-rose-500/20" :disabled="state==='saving'" @click="discard">Discard</button>
      </template>
      <input v-model="title" placeholder="title (optional)" class="flex-1 min-w-[8rem] px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm outline-none focus:border-white/25" />
    </div>
    <p v-if="error" class="mt-2 text-sm text-rose-300">{{ error }}</p>
    <div v-if="markers.length" class="mt-2 flex flex-wrap gap-1.5">
      <span v-for="(m, i) in markers" :key="i" class="text-[11px] px-2 py-0.5 rounded-full bg-white/5 flex items-center gap-1">
        <font-awesome-icon :icon="['fas','stopwatch']" class="opacity-60" /> {{ mmss(m.t_sec*1000) }}
        <input v-model="m.label" placeholder="tag…" class="bg-transparent outline-none w-16 text-slate-300 placeholder:text-slate-600" />
      </span>
    </div>
  </div>
</template>
