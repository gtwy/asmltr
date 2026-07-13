<script setup>
// Voice — talk to the full agent and hear it back. The core speech layer streams the reply through
// TTS sentence-by-sentence: an instant chime, an ambient bed while it works, an optional spoken
// acknowledgment, then the answer spoken as it's generated (intermediary narration included).
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import { voice } from '@/services/api'

const prompt = ref("Walk me through what you'd check first if a web service returned a 502, in two or three sentences.")
const ackOn = ref(true)
const busy = ref(false)
const status = ref('')
const rows = ref([])          // { kind:'ack'|'text', text }
const scrollBox = ref(null)
let ctrl = null

// --- audio playback ----------------------------------------------------------
const chime = new Audio(voice.assetUrl('chime.ogg'))
const drone = new Audio(voice.assetUrl('drone.ogg')); drone.loop = true; drone.volume = 0.35
const queue = []; let playing = false
function enqueueAudio(b64, mime) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  queue.push(URL.createObjectURL(new Blob([bytes], { type: mime || 'audio/mpeg' })))
  if (!playing) playNext()
}
function playNext() {
  const url = queue.shift()
  if (!url) { playing = false; return }
  playing = true
  const a = new Audio(url)
  a.onended = a.onerror = () => { URL.revokeObjectURL(url); playNext() }
  a.play().catch(() => playNext())
}
function stopDrone() { try { drone.pause(); drone.currentTime = 0 } catch (_) {} }
function stopAllAudio() { stopDrone(); queue.length = 0; playing = false }
function scrollDown() { nextTick(() => { const el = scrollBox.value; if (el) el.scrollTop = el.scrollHeight }) }

onMounted(async () => { try { ackOn.value = (await voice.getAck()).enabled } catch (_) {} })
onBeforeUnmount(() => { try { ctrl?.abort() } catch (_) {} stopAllAudio() })

function toggleAck() { ackOn.value = !ackOn.value; voice.setAck(ackOn.value).catch(() => {}) }

function speak() {
  const text = prompt.value.trim()
  if (!text || busy.value) return
  busy.value = true; rows.value = []; status.value = 'connecting…'
  const t0 = performance.now()
  ctrl = voice.speak({ conversation_key: 'web:voice-' + Date.now() + '-' + Math.floor(Math.random() * 1e4), text }, {
    onCue: (cue) => {
      if (cue === 'chime') { chime.currentTime = 0; chime.play().catch(() => {}); status.value = 'on it…' }
      else if (cue === 'drone-start') drone.play().catch(() => {})
      else if (cue === 'drone-stop') { stopDrone(); status.value = `answering… (${((performance.now() - t0) / 1000).toFixed(1)}s to first reply)` }
    },
    onAudio: (f) => { enqueueAudio(f.b64, f.mime); if (f.role === 'ack') { rows.value.push({ kind: 'ack', text: f.text || '(acknowledgment)' }); scrollDown() } },
    onText: (f) => { rows.value.push({ kind: 'text', text: f.text }); scrollDown() },
    onDone: () => { status.value = `done · ${((performance.now() - t0) / 1000).toFixed(1)}s total`; busy.value = false; ctrl = null },
    onError: (m) => { status.value = 'error: ' + m; busy.value = false; ctrl = null; stopDrone() }
  })
}
function stop() { try { ctrl?.abort() } catch (_) {} stopAllAudio(); busy.value = false; status.value = 'stopped' }
</script>

<template>
  <div>
    <PageHeader title="Voice" subtitle="Talk to the full agent and hear it back — streamed through speech as it's generated">
      <template #actions>
        <button
          type="button"
          class="rounded-lg border px-3 py-1.5 text-sm transition-colors"
          :class="ackOn ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' : 'border-white/10 bg-white/5 text-slate-400'"
          :title="ackOn ? 'A short spoken “on it” plays while the agent works. Click to turn off.' : 'No spoken acknowledgment. Click to turn on.'"
          @click="toggleAck"
        >{{ ackOn ? '● spoken ack on' : '○ spoken ack off' }}</button>
      </template>
    </PageHeader>

    <div class="mx-auto max-w-2xl">
      <div class="glass p-4">
        <textarea
          v-model="prompt"
          rows="3"
          placeholder="Ask something…"
          class="w-full resize-y rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-brand-violet/60 focus:bg-white/[0.06]"
          @keydown.enter.exact.prevent="speak"
        ></textarea>
        <div class="mt-3 flex items-center gap-2">
          <button
            type="button"
            :disabled="busy || !prompt.trim()"
            class="rounded-lg bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-brand-violet/30 transition-opacity disabled:opacity-40"
            @click="speak"
          >▶ Speak</button>
          <button
            v-if="busy"
            type="button"
            class="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm font-semibold text-rose-300 hover:bg-rose-500/20"
            @click="stop"
          >⏹ Stop</button>
          <span class="ml-auto text-xs text-slate-500">{{ status }}</span>
        </div>
      </div>

      <div v-if="rows.length" ref="scrollBox" class="glass mt-4 max-h-[46vh] space-y-2 overflow-y-auto p-4">
        <div v-for="(r, i) in rows" :key="i" class="flex justify-start">
          <div
            class="max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-sm border px-3 py-2 text-[13px] leading-snug"
            :class="r.kind === 'ack' ? 'border-white/10 bg-white/[0.03] italic text-slate-400' : 'border-white/10 bg-white/[0.05] text-slate-100'"
          >{{ r.text }}</div>
        </div>
      </div>

      <p class="mt-4 text-center text-[11px] leading-relaxed text-slate-500">
        You'll hear a chime instantly, an ambient bed while the full agent works, an optional spoken “on it,”
        then the answer spoken sentence-by-sentence as it's generated. Short replies arrive in one burst
        (nothing to spread); longer ones stream progressively. Text→audio lag is the TTS provider (OpenAI today).
      </p>
    </div>
  </div>
</template>
