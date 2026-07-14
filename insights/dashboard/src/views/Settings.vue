<script setup>
// Settings — organised into tabs so it can grow: Identity (who the agent is), Runtime (the Agent
// SDK + model), Voice (behaviour). Each section is self-contained; add a tab as new areas appear.
import { ref, onMounted, computed } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import { runtime, voice, identity, update } from '@/services/api'

const TABS = [
  { id: 'identity', label: 'Identity', icon: '🪪' },
  { id: 'runtime', label: 'Runtime', icon: '⚙' },
  { id: 'updates', label: 'Updates', icon: '↑' },
  { id: 'voice', label: 'Voice', icon: '🎙' }
]
const tab = ref('identity')
const busy = ref('')      // which action is in flight
const notice = ref('')

// --- Identity (the Self / Likeness plane): anchor (name + essence) + living layer (prefs + story) ---
const idn = ref(null)
const d = ref({ name: '', self_description: '', preferences: '', story: '' })
const showPreamble = ref(false)
const nameDirty = computed(() => idn.value && d.value.name.trim() && d.value.name.trim() !== idn.value.name)
const idnDirty = computed(() => idn.value && (nameDirty.value
  || d.value.self_description !== idn.value.self_description
  || d.value.preferences !== idn.value.preferences
  || d.value.story !== idn.value.story))
function syncIdentity() { d.value = { name: idn.value.name, self_description: idn.value.self_description, preferences: idn.value.preferences || '', story: idn.value.story || '' } }
async function loadIdentity() { try { idn.value = await identity.get(); syncIdentity() } catch (_) {} }
async function saveIdentity() {
  busy.value = 'identity'; notice.value = ''
  const renamed = nameDirty.value
  try {
    const body = {}
    if (nameDirty.value) body.name = d.value.name.trim()
    if (d.value.self_description !== idn.value.self_description) body.self_description = d.value.self_description
    if (d.value.preferences !== idn.value.preferences) body.preferences = d.value.preferences
    if (d.value.story !== idn.value.story) body.story = d.value.story
    idn.value = await identity.set(body); syncIdentity()
    notice.value = renamed
      ? `Saved. The core uses “${idn.value.name}” from the next turn — but connector-level name (Discord wake word, the shell alias, the bot's own username) needs a service restart + re-provision to fully realign.`
      : 'Identity saved — applies to the next turn on every surface.'
  } catch (e) { notice.value = 'Failed: ' + e.message } finally { busy.value = '' }
}

// --- Updates (git code self-update) ---
const upd = ref(null)        // { behind, available, head, remote, changelog }
const updAuto = ref(false)
async function loadUpdates() {
  try { upd.value = await update.status(true) } catch (_) {}
  try { updAuto.value = (await update.getAuto()).auto } catch (_) {}
}
async function toggleUpdAuto() {
  busy.value = 'upd-auto'
  try { updAuto.value = (await update.setAuto(!updAuto.value)).auto } catch (e) { notice.value = 'Failed: ' + e.message } finally { busy.value = '' }
}
async function runUpdate() {
  busy.value = 'upd-run'; notice.value = ''
  try { await update.run(); notice.value = 'Update session started — a background agent is running the update. Watch it in Live (session “self-update”); it health-checks + auto-rolls-back on failure.' }
  catch (e) { notice.value = 'Failed to start: ' + e.message } finally { busy.value = '' }
}

// --- Runtime (SDK + model) ---
const rt = ref(null)
const customModel = ref('')
const MODEL_CHOICES = [
  { id: 'opus', label: 'Opus', hint: 'latest Opus (recommended)' },
  { id: 'sonnet', label: 'Sonnet', hint: 'faster, latest Sonnet' },
  { id: 'haiku', label: 'Haiku', hint: 'fastest, lightest' },
  { id: '', label: 'SDK default', hint: '1M-context Opus' }
]
const isChoice = (id) => (rt.value?.model?.configured ?? '') === id
async function loadRuntime(fetch = true) { try { rt.value = await runtime.get(fetch) } catch (e) { notice.value = 'Could not load runtime: ' + e.message } }
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
    notice.value = 'SDK update started — the core will reinstall and restart. This can take a minute; the version refreshes automatically.'
    const before = rt.value?.sdk?.installed; let tries = 0
    const timer = setInterval(async () => {
      tries++
      try { const r = await runtime.get(true); if (r?.sdk?.installed && r.sdk.installed !== before) { rt.value = r; notice.value = `Updated to ${r.sdk.installed}.`; clearInterval(timer) } } catch (_) {}
      if (tries > 30) clearInterval(timer)
    }, 6000)
  } catch (e) { notice.value = 'Update failed to start: ' + e.message } finally { busy.value = '' }
}

// --- Voice ---
const ackOn = ref(true)
function toggleAck() { ackOn.value = !ackOn.value; voice.setAck(ackOn.value).catch(() => {}) }

onMounted(async () => {
  await Promise.all([loadIdentity(), loadRuntime(true), loadUpdates()])
  try { ackOn.value = (await voice.getAck()).enabled } catch (_) {}
})
</script>

<template>
  <div>
    <PageHeader title="Settings" subtitle="Identity, runtime, and behaviour" />

    <div class="mx-auto max-w-2xl">
      <!-- tab bar -->
      <div class="mb-5 flex gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1">
        <button
          v-for="t in TABS" :key="t.id" type="button"
          class="flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors"
          :class="tab === t.id ? 'bg-brand-violet/20 text-violet-200' : 'text-slate-400 hover:text-slate-200'"
          @click="tab = t.id"
        >{{ t.icon }} {{ t.label }}</button>
      </div>

      <!-- Identity -->
      <div v-show="tab === 'identity'" class="glass p-5">
        <h3 class="mb-1 text-sm font-semibold text-slate-200">Identity</h3>
        <p class="mb-4 text-[12px] text-slate-500">Who this agent is. Asserted at the top of <em>every</em> session (terminal + all channels) so identity is declared, not inferred — the fix for cross-agent drift.</p>
        <template v-if="idn">
          <label class="mb-1 block text-[11px] uppercase tracking-wide text-slate-500">Name</label>
          <input
            v-model="d.name"
            type="text"
            class="mb-4 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm font-semibold text-slate-100 outline-none transition-colors focus:border-brand-violet/60 focus:bg-white/[0.06]"
          />
          <label class="mb-1 block text-[11px] uppercase tracking-wide text-slate-500">Essence <span class="normal-case text-slate-600">— the stable core, asserted in the anchor</span></label>
          <textarea
            v-model="d.self_description"
            rows="5"
            placeholder="Who you are, in your own words…"
            class="mb-4 w-full resize-y rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[13px] leading-relaxed text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-brand-violet/60 focus:bg-white/[0.06]"
          ></textarea>
          <label class="mb-1 block text-[11px] uppercase tracking-wide text-slate-500">Preferences <span class="normal-case text-slate-600">— tendencies &amp; working style (not rules; can be self-updated over time)</span></label>
          <textarea
            v-model="d.preferences"
            rows="4"
            placeholder="How you tend to work, what you value…"
            class="mb-4 w-full resize-y rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[13px] leading-relaxed text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-brand-violet/60 focus:bg-white/[0.06]"
          ></textarea>
          <label class="mb-1 block text-[11px] uppercase tracking-wide text-slate-500">Story &amp; context <span class="normal-case text-slate-600">— the narrative you carry (grows over time)</span></label>
          <textarea
            v-model="d.story"
            rows="5"
            placeholder="Formative events, relationships, the accumulated narrative…"
            class="w-full resize-y rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[13px] leading-relaxed text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-brand-violet/60 focus:bg-white/[0.06]"
          ></textarea>
          <div class="mt-2 flex items-center gap-2">
            <button
              type="button"
              :disabled="!idnDirty || busy === 'identity'"
              class="rounded-lg bg-brand-gradient px-4 py-1.5 text-xs font-semibold text-white shadow-lg shadow-brand-violet/30 disabled:opacity-40"
              @click="saveIdentity"
            >{{ busy === 'identity' ? 'saving…' : 'Save' }}</button>
            <button type="button" class="text-xs text-slate-400 hover:text-slate-200" @click="showPreamble = !showPreamble">
              {{ showPreamble ? 'hide' : 'preview' }} the anchor every session sees
            </button>
          </div>
          <pre v-if="showPreamble" class="mt-3 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-lg border border-white/5 bg-black/30 p-3 text-[11px] leading-relaxed text-slate-400">{{ idn.preamble }}</pre>
        </template>
        <p v-else class="py-3 text-center text-sm text-slate-500">loading…</p>
      </div>

      <!-- Runtime -->
      <div v-show="tab === 'runtime'" class="glass p-5">
        <h3 class="mb-1 text-sm font-semibold text-slate-200">Agent runtime</h3>
        <p class="mb-4 text-[12px] text-slate-500">The Agent SDK gates which models are reachable — an old SDK silently pins you to an old model. Keep it current and use a model alias to track the latest.</p>
        <template v-if="rt">
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
          <label class="mb-5 flex cursor-pointer items-center justify-between gap-3">
            <span>
              <span class="text-sm text-slate-200">Auto-update the SDK</span>
              <span class="block text-[12px] text-slate-500">Check every 6h and upgrade + restart automatically, so the model never silently goes stale.</span>
            </span>
            <button type="button" :disabled="busy === 'auto'" class="relative h-6 w-11 shrink-0 rounded-full transition-colors" :class="rt.autoUpdate ? 'bg-brand-violet' : 'bg-white/15'" @click="toggleAuto">
              <span class="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all" :class="rt.autoUpdate ? 'left-[22px]' : 'left-0.5'"></span>
            </button>
          </label>
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
        <p v-else class="py-3 text-center text-sm text-slate-500">loading…</p>
      </div>

      <!-- Updates (git code self-update) -->
      <div v-show="tab === 'updates'" class="glass p-5">
        <h3 class="mb-1 text-sm font-semibold text-slate-200">Updates</h3>
        <p class="mb-4 text-[12px] text-slate-500">asmltr's own code. New commits on <span class="font-mono">origin/main</span> are detected every 15 min; installing runs a background agent session (the UPDATE-WITH-AGENT procedure) that health-checks and auto-rolls-back on failure.</p>
        <template v-if="upd">
          <div class="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-white/5 bg-black/20 p-3">
            <div class="min-w-0">
              <div class="text-[11px] uppercase tracking-wide text-slate-500">Code</div>
              <div class="font-mono text-sm text-slate-200">{{ upd.head || '—' }}
                <span v-if="!upd.available" class="ml-1 text-[11px] text-emerald-400">✓ up to date</span>
                <span v-else class="ml-1 text-[11px] text-amber-400">→ {{ upd.behind }} behind ({{ upd.remote }})</span>
              </div>
            </div>
            <button
              type="button"
              :disabled="busy === 'upd-run' || !upd.available"
              class="ml-auto rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40"
              :class="upd.available ? 'border-amber-400/30 bg-amber-400/10 text-amber-300 hover:bg-amber-400/20' : 'border-white/10 bg-white/5 text-slate-500'"
              @click="runUpdate"
            >{{ busy === 'upd-run' ? 'starting…' : (upd.available ? '↑ Update now' : 'Latest') }}</button>
          </div>
          <div v-if="upd.available && upd.changelog?.length" class="mb-4 max-h-40 overflow-y-auto rounded-lg border border-white/5 bg-black/20 p-3">
            <div class="mb-1 text-[11px] uppercase tracking-wide text-slate-500">Incoming ({{ upd.behind }})</div>
            <div v-for="(c, i) in upd.changelog" :key="i" class="truncate font-mono text-[11px] text-slate-400">{{ c }}</div>
          </div>
          <label class="flex cursor-pointer items-center justify-between gap-3">
            <span>
              <span class="text-sm text-slate-200">Auto-install updates</span>
              <span class="block text-[12px] text-slate-500">When a new commit is detected, run the update session automatically (with rollback safety).</span>
            </span>
            <button type="button" :disabled="busy === 'upd-auto'" class="relative h-6 w-11 shrink-0 rounded-full transition-colors" :class="updAuto ? 'bg-brand-violet' : 'bg-white/15'" @click="toggleUpdAuto">
              <span class="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all" :class="updAuto ? 'left-[22px]' : 'left-0.5'"></span>
            </button>
          </label>
        </template>
        <p v-else class="py-3 text-center text-sm text-slate-500">loading…</p>
      </div>

      <!-- Voice -->
      <div v-show="tab === 'voice'" class="glass p-5">
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

      <p v-if="notice" class="mt-4 text-center text-[12px] text-slate-400">{{ notice }}</p>
    </div>
  </div>
</template>
