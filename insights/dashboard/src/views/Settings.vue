<script setup>
// Settings — the agent runtime (the SDK version that GATES which models are reachable, the model
// selection, and SDK auto-update) plus a couple of behavioural toggles. Keeping the SDK current is
// how the underlying model stays up to date; an old SDK silently pins you to an old model.
import { ref, onMounted, computed } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import { runtime, voice } from '@/services/api'

const rt = ref(null)
const loading = ref(true)
const busy = ref('')      // which action is in flight
const notice = ref('')
const customModel = ref('')

const MODEL_CHOICES = [
  { id: 'opus', label: 'Opus', hint: 'latest Opus (recommended)' },
  { id: 'sonnet', label: 'Sonnet', hint: 'faster, latest Sonnet' },
  { id: 'haiku', label: 'Haiku', hint: 'fastest, lightest' },
  { id: '', label: 'SDK default', hint: '1M-context Opus' }
]
const configured = computed(() => rt.value?.model?.configured ?? '')
const isChoice = (id) => configured.value === id

async function load(fetch = true) {
  loading.value = true
  try { rt.value = await runtime.get(fetch) } catch (e) { notice.value = 'Could not load runtime: ' + e.message }
  finally { loading.value = false }
}
onMounted(() => load(true))

async function pickModel(id) {
  busy.value = 'model'; notice.value = ''
  try { const r = await runtime.setModel(id); rt.value.model.configured = r.model; notice.value = `Model set to “${r.model || 'SDK default'}” — applies on the next turn.` }
  catch (e) { notice.value = 'Failed: ' + e.message } finally { busy.value = '' }
}
async function setCustom() { const m = customModel.value.trim(); if (m) { await pickModel(m); customModel.value = '' } }

async function toggleAuto() {
  busy.value = 'auto'
  try { const r = await runtime.setAutoUpdate(!rt.value.autoUpdate); rt.value.autoUpdate = r.autoUpdate }
  catch (e) { notice.value = 'Failed: ' + e.message } finally { busy.value = '' }
}

async function updateSdk() {
  busy.value = 'update'; notice.value = ''
  try {
    await runtime.update()
    notice.value = 'SDK update started — the core will reinstall and restart. This can take a minute; the page will refresh the version automatically.'
    // poll for the version to change / core to come back
    const before = rt.value?.sdk?.installed
    let tries = 0
    const timer = setInterval(async () => {
      tries++
      try { const r = await runtime.get(true); if (r?.sdk?.installed && r.sdk.installed !== before) { rt.value = r; notice.value = `Updated to ${r.sdk.installed}.`; clearInterval(timer) } }
      catch (_) {}
      if (tries > 30) clearInterval(timer)
    }, 6000)
  } catch (e) { notice.value = 'Update failed to start: ' + e.message } finally { busy.value = '' }
}

// voice ack toggle (a behavioural setting, consolidated here)
const ackOn = ref(true)
onMounted(async () => { try { ackOn.value = (await voice.getAck()).enabled } catch (_) {} })
function toggleAck() { ackOn.value = !ackOn.value; voice.setAck(ackOn.value).catch(() => {}) }
</script>

<template>
  <div>
    <PageHeader title="Settings" subtitle="Agent runtime, model selection, and behaviour" />

    <div class="mx-auto max-w-2xl space-y-5">
      <!-- Agent runtime -->
      <div class="glass p-5">
        <h3 class="mb-1 text-sm font-semibold text-slate-200">Agent runtime</h3>
        <p class="mb-4 text-[12px] text-slate-500">The Agent SDK gates which models are reachable — an old SDK silently pins you to an old model. Keep it current and use a model alias to track the latest.</p>

        <p v-if="loading" class="py-4 text-center text-sm text-slate-500">loading…</p>
        <template v-else-if="rt">
          <!-- SDK version -->
          <div class="mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-white/5 bg-black/20 p-3">
            <div class="min-w-0">
              <div class="text-[11px] uppercase tracking-wide text-slate-500">Agent SDK</div>
              <div class="font-mono text-sm text-slate-200">{{ rt.sdk.installed || '—' }}
                <span v-if="rt.sdk.latest && !rt.sdk.updateAvailable" class="ml-1 text-[11px] text-emerald-400">✓ up to date</span>
                <span v-else-if="rt.sdk.updateAvailable" class="ml-1 text-[11px] text-amber-400">→ {{ rt.sdk.latest }} available</span>
              </div>
            </div>
            <button
              type="button"
              :disabled="busy === 'update' || !rt.sdk.updateAvailable"
              class="ml-auto rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40"
              :class="rt.sdk.updateAvailable ? 'border-amber-400/30 bg-amber-400/10 text-amber-300 hover:bg-amber-400/20' : 'border-white/10 bg-white/5 text-slate-500'"
              @click="updateSdk"
            >{{ busy === 'update' ? 'starting…' : (rt.sdk.updateAvailable ? '↑ Update now' : 'Latest') }}</button>
          </div>

          <!-- SDK auto-update -->
          <label class="mb-5 flex cursor-pointer items-center justify-between gap-3">
            <span>
              <span class="text-sm text-slate-200">Auto-update the SDK</span>
              <span class="block text-[12px] text-slate-500">Check every 6h and upgrade + restart automatically, so the model never silently goes stale.</span>
            </span>
            <button type="button" :disabled="busy === 'auto'" class="relative h-6 w-11 shrink-0 rounded-full transition-colors" :class="rt.autoUpdate ? 'bg-brand-violet' : 'bg-white/15'" @click="toggleAuto">
              <span class="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all" :class="rt.autoUpdate ? 'left-[22px]' : 'left-0.5'"></span>
            </button>
          </label>

          <!-- Model -->
          <div>
            <div class="mb-1.5 text-[11px] uppercase tracking-wide text-slate-500">Model
              <span v-if="rt.model.resolved" class="ml-1 font-mono text-slate-400">· running {{ rt.model.resolved }}</span>
            </div>
            <div class="flex flex-wrap gap-2">
              <button v-for="c in MODEL_CHOICES" :key="c.id"
                type="button" :disabled="busy === 'model'"
                class="rounded-lg border px-3 py-2 text-left text-xs transition-colors"
                :class="isChoice(c.id) ? 'border-brand-violet/60 bg-brand-violet/15 text-violet-200' : 'border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/10'"
                @click="pickModel(c.id)">
                <div class="font-semibold">{{ c.label }}</div>
                <div class="text-[10px] text-slate-500">{{ c.hint }}</div>
              </button>
            </div>
            <div class="mt-2 flex items-center gap-2">
              <input v-model="customModel" type="text" placeholder="or a full model id (e.g. claude-opus-4-8)"
                class="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 font-mono text-xs text-slate-100 outline-none focus:border-brand-violet/60"
                @keydown.enter.prevent="setCustom" />
              <button type="button" :disabled="!customModel.trim() || busy === 'model'" class="shrink-0 rounded-lg bg-brand-gradient px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40" @click="setCustom">Set</button>
            </div>
          </div>
        </template>
      </div>

      <!-- Voice -->
      <div class="glass p-5">
        <h3 class="mb-3 text-sm font-semibold text-slate-200">Voice</h3>
        <label class="flex cursor-pointer items-center justify-between gap-3">
          <span>
            <span class="text-sm text-slate-200">Spoken acknowledgment</span>
            <span class="block text-[12px] text-slate-500">A short spoken “on it” plays while the agent works, so a long turn isn't silent.</span>
          </span>
          <button type="button" class="relative h-6 w-11 shrink-0 rounded-full transition-colors" :class="ackOn ? 'bg-brand-violet' : 'bg-white/15'" @click="toggleAck">
            <span class="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all" :class="ackOn ? 'left-[22px]' : 'left-0.5'"></span>
          </button>
        </label>
      </div>

      <p v-if="notice" class="text-center text-[12px] text-slate-400">{{ notice }}</p>
    </div>
  </div>
</template>
