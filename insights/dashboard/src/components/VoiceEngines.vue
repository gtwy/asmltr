<script setup>
// Voice engines (epic #113) — pick which engine fills each voice ROLE (transcribe / realtime / synthesize
// / converse) and see its capabilities. Surfaces gate features on the resolved engine's manifest. Mirrors
// Settings→Engines for reasoning. Bindings persist server-side; engines with a missing key show as unavailable.
import { ref, onMounted } from 'vue'
import { voiceEnginesApi } from '@/services/api'

const data = ref(null)
const error = ref(null)
const busy = ref('')

const ROLE_LABEL = {
  transcribe: 'Transcribe', realtime_transcribe: 'Realtime transcribe',
  synthesize: 'Synthesize (TTS)', converse: 'Converse (duplex)'
}
const ROLE_DESC = {
  transcribe: 'file/clip speech → text', realtime_transcribe: 'streaming speech → text + VAD',
  synthesize: 'text → speech', converse: 'duplex speech ↔ speech (future) — collapses transcribe+synthesize'
}
const CAP_KEYS = ['diarization', 'known_speakers', 'word_timestamps', 'streaming', 'vad', 'low_latency', 'offline']

async function load() { try { data.value = await voiceEnginesApi.get() } catch (e) { error.value = e.message } }
function enginesFor(role) { return Object.entries(data.value.engines).filter(([, e]) => e.roles.includes(role)).map(([id, e]) => ({ id, ...e })) }
function boundId(role) { return data.value.bindings[role] || (data.value.resolved[role] && data.value.resolved[role].engine_id) || '' }
function caps(role) { return (data.value.resolved[role] && data.value.resolved[role].capabilities) || {} }

async function bind(role, engine) {
  busy.value = role
  try { await voiceEnginesApi.bind(role, engine || null); await load() } catch (e) { error.value = e.message } finally { busy.value = '' }
}
onMounted(load)
</script>

<template>
  <section class="space-y-4 mb-7">
    <h4 class="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-slate-300">
      <font-awesome-icon :icon="['fas','microphone']" class="text-sm text-brand-violet" /> Voice engines
      <span class="font-medium normal-case tracking-normal text-slate-500">· which engine fills each role</span>
    </h4>
    <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>
    <div v-if="!data" class="text-sm text-slate-500">Loading…</div>
    <div v-else class="space-y-4">
      <div v-for="role in data.roles" :key="role" class="rounded-xl border border-white/10 bg-white/[0.03] p-3">
        <div class="flex items-center justify-between gap-3 mb-2">
          <div>
            <span class="text-sm font-medium text-slate-200">{{ ROLE_LABEL[role] }}</span>
            <span class="block text-[11px] text-slate-500">{{ ROLE_DESC[role] }}</span>
          </div>
          <select :value="boundId(role)" :disabled="busy === role" @change="bind(role, $event.target.value)"
                  class="text-sm rounded-lg bg-white/5 border border-white/10 px-2 py-1.5 outline-none focus:border-white/25 max-w-[16rem]">
            <option value="">— none —</option>
            <option v-for="e in enginesFor(role)" :key="e.id" :value="e.id" :disabled="!data.availability[e.id]">
              {{ e.label }}{{ data.availability[e.id] ? '' : ' (no key)' }}
            </option>
          </select>
        </div>
        <div v-if="enginesFor(role).length" class="flex flex-wrap gap-1.5">
          <span v-for="k in CAP_KEYS.filter(k => caps(role)[k])" :key="k" class="text-[10px] px-1.5 py-0.5 rounded-full text-emerald-300 bg-emerald-500/10">{{ k.replace(/_/g,' ') }}</span>
          <span v-if="caps(role).cost_per_min != null" class="text-[10px] px-1.5 py-0.5 rounded-full text-slate-400 bg-white/5">${{ caps(role).cost_per_min }}/min</span>
          <span v-if="caps(role).provider" class="text-[10px] px-1.5 py-0.5 rounded-full text-slate-400 bg-white/5">{{ caps(role).provider }}</span>
        </div>
        <p v-else class="text-[11px] text-slate-600">No engine available for this role yet.</p>
      </div>
    </div>
  </section>
</template>
