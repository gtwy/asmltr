<script setup>
// Settings — the field/section DEFINITIONS come from the shared console manifest (GET /api/manifest),
// the ONE source of truth also driving the terminal TUI. This view keeps its hand-crafted layout +
// the bespoke status widgets (SDK version, changelog); only the declarative bits (tabs, fields, model
// choices, toggle copy) are sourced from the manifest, so adding a setting updates both GUI and TUI.
import { ref, onMounted, computed, reactive } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import { api, runtime, voice, identity, update } from '@/services/api'
import { useUpdateProgress } from '@/composables/useUpdateProgress'
import { useTurnNotifications } from '@/composables/useTurnNotifications'

// Shared progress poller — calling begin() pops the global App.vue progress panel immediately.
const { begin: updBegin } = useUpdateProgress()
// Turn-complete browser notifications (moved here from the sidebar). Shared singleton state.
const { supported: notifySupported, enabled: notifyOn, permission: notifyPerm, toggle: toggleNotify } = useTurnNotifications()

const manifest = ref(null)
const tab = ref('identity')
const busy = ref('')      // which action is in flight
const notice = ref('')

// --- manifest-derived definitions (single source of truth) ---
const sections = computed(() => manifest.value?.settings || [])
// The manifest drives the shared GUI+TUI tabs; "Notifications" is appended GUI-only because it's a
// browser capability (Notification API) with no meaning in the terminal.
const TABS = computed(() => [
  ...sections.value.map((s) => ({ id: s.id, label: s.label, icon: s.icon })),
  { id: 'notifications', label: 'Notifications', icon: '✦' },
])
function section(id) { return sections.value.find((s) => s.id === id) || { fields: [] } }
function field(sectionId, fieldId) { return (section(sectionId).fields || []).find((f) => f.id === fieldId) || {} }
const identityFields = computed(() => section('identity').fields || [])
const modelChoices = computed(() => field('runtime', 'model').choices || [])

// --- Identity (the Self / Likeness plane) ---
const idn = ref(null)
const d = reactive({ name: '', self_description: '', preferences: '', story: '', aesthetic: '', palette: '' })
const showPreamble = ref(false)
const nameDirty = computed(() => idn.value && d.name.trim() && d.name.trim() !== idn.value.name)
const idnDirty = computed(() => idn.value && (nameDirty.value
  || d.self_description !== idn.value.self_description
  || d.preferences !== idn.value.preferences
  || d.story !== idn.value.story
  || d.aesthetic !== (idn.value.aesthetic || '')
  || d.palette !== (idn.value.palette || '')))
function syncIdentity() { Object.assign(d, { name: idn.value.name, self_description: idn.value.self_description, preferences: idn.value.preferences || '', story: idn.value.story || '', aesthetic: idn.value.aesthetic || '', palette: idn.value.palette || '' }) }
async function loadIdentity() { try { idn.value = await identity.get(); syncIdentity() } catch (_) {} }
async function saveIdentity() {
  busy.value = 'identity'; notice.value = ''
  const renamed = nameDirty.value
  try {
    const body = {}
    if (nameDirty.value) body.name = d.name.trim()
    if (d.self_description !== idn.value.self_description) body.self_description = d.self_description
    if (d.preferences !== idn.value.preferences) body.preferences = d.preferences
    if (d.story !== idn.value.story) body.story = d.story
    if (d.aesthetic !== (idn.value.aesthetic || '')) body.aesthetic = d.aesthetic
    if (d.palette !== (idn.value.palette || '')) body.palette = d.palette
    idn.value = await identity.set(body); syncIdentity()
    notice.value = renamed
      ? `Saved. The core uses “${idn.value.name}” from the next turn — but connector-level name (Discord wake word, the shell alias, the bot's own username) needs a service restart + re-provision to fully realign.`
      : 'Identity saved — applies to the next turn on every surface.'
  } catch (e) { notice.value = 'Failed: ' + e.message } finally { busy.value = '' }
}

// --- Updates (code self-update: deterministic, versioned, channel-based) ---
const upd = ref(null)
const updAuto = ref(false)
const updChannel = ref('edge')
async function loadUpdates() {
  try { upd.value = await update.status(true) } catch (_) {}
  try { updAuto.value = (await update.getAuto()).auto } catch (_) {}
  try { updChannel.value = (await update.getChannel()).channel } catch (_) {}
}
async function toggleUpdAuto() {
  busy.value = 'upd-auto'
  try { updAuto.value = (await update.setAuto(!updAuto.value)).auto } catch (e) { notice.value = 'Failed: ' + e.message } finally { busy.value = '' }
}
async function setChannel(ch) {
  if (ch === updChannel.value) return
  busy.value = 'upd-channel'; notice.value = ''
  try { updChannel.value = (await update.setChannel(ch)).channel; upd.value = await update.status(true); notice.value = `Update channel set to “${ch}”.` }
  catch (e) { notice.value = 'Failed: ' + e.message } finally { busy.value = '' }
}
async function runUpdate() {
  busy.value = 'upd-run'; notice.value = ''
  updBegin() // show the persistent progress panel immediately
  try { await update.run(); notice.value = 'Update started — the deterministic updater is running (fetch → install → restart → verify, auto-rollback on failure). Progress shows at the top of every page and survives the restart.' }
  catch (e) { notice.value = 'Failed to start: ' + e.message } finally { busy.value = '' }
}

// --- Runtime (SDK + model) ---
const rt = ref(null)
const customModel = ref('')
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
async function toggleCliBypass() {
  busy.value = 'cli-bypass'
  try { const r = await runtime.setCliBypass(!rt.value.cliBypass); rt.value.cliBypass = r.cliBypass; notice.value = `Terminal sessions now launch in ${r.cliBypass ? 'bypass-permissions (full-autonomy)' : 'normal-permission'} mode — applies to the next ‘asmltr claude’.` }
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
// TTS voice/model + STT model — server-persisted config; the choice lists come from the manifest.
const vcfg = ref(null) // { tts: { provider, voice, model, … }, stt: { model, … } }
const customVoice = ref('')
const customTtsModel = ref('')
const ttsProviderChoices = computed(() => field('voice', 'tts_provider').choices || [])
const ttsVoiceChoices = computed(() => field('voice', 'tts_voice').choices || [])
const ttsModelChoices = computed(() => field('voice', 'tts_model').choices || [])
const sttModelChoices = computed(() => field('voice', 'stt_model').choices || [])
async function loadVoiceCfg() { try { vcfg.value = await voice.getConfig() } catch (_) {} }
async function setVoiceCfg(part) {
  busy.value = 'voicecfg'; notice.value = ''
  try { vcfg.value = await voice.setConfig(part); notice.value = 'Voice settings saved — applies to the next clip.' }
  catch (e) { notice.value = 'Failed: ' + e.message } finally { busy.value = '' }
}
async function setCustomVoice() { const v = customVoice.value.trim(); if (v) { await setVoiceCfg({ tts: { voice: v } }); customVoice.value = '' } }
async function setCustomTtsModel() { const m = customTtsModel.value.trim(); if (m) { await setVoiceCfg({ tts: { model: m } }); customTtsModel.value = '' } }

onMounted(async () => {
  try { manifest.value = await api.manifest() } catch (_) {}
  await Promise.all([loadIdentity(), loadRuntime(true), loadUpdates(), loadVoiceCfg()])
  try { ackOn.value = (await voice.getAck()).enabled } catch (_) {}
})
</script>

<template>
  <div>
    <PageHeader title="Settings" subtitle="Identity, runtime, and behaviour" />

    <div class="mx-auto max-w-2xl">
      <p v-if="!manifest" class="glass py-8 text-center text-sm text-slate-500">loading settings…</p>
      <template v-else>
        <!-- tab bar (from the manifest) -->
        <div class="mb-5 flex gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1">
          <button
            v-for="t in TABS" :key="t.id" type="button"
            class="flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors"
            :class="tab === t.id ? 'bg-brand-violet/20 text-violet-200' : 'text-slate-400 hover:text-slate-200'"
            @click="tab = t.id"
          ><AppIcon :glyph="t.icon" class="mr-1" /> {{ t.label }}</button>
        </div>

        <!-- Identity — fields from the manifest -->
        <div v-show="tab === 'identity'" class="glass p-5">
          <h3 class="mb-1 text-sm font-semibold text-slate-200">{{ section('identity').label }}</h3>
          <p class="mb-4 text-[12px] text-slate-500">{{ section('identity').desc }}</p>
          <template v-if="idn">
            <template v-for="fld in identityFields" :key="fld.id">
              <label class="mb-1 block text-[11px] uppercase tracking-wide text-slate-500">{{ fld.label }}<span v-if="fld.desc" class="normal-case text-slate-600"> — {{ fld.desc }}</span></label>
              <input
                v-if="fld.type === 'text'"
                v-model="d[fld.id]" type="text"
                class="mb-4 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm font-semibold text-slate-100 outline-none transition-colors focus:border-brand-violet/60 focus:bg-white/[0.06]"
              />
              <textarea
                v-else
                v-model="d[fld.id]" :rows="fld.rows || 4" :placeholder="fld.placeholder"
                class="mb-4 w-full resize-y rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[13px] leading-relaxed text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-brand-violet/60 focus:bg-white/[0.06]"
              ></textarea>
            </template>
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

        <!-- Runtime — model choices from the manifest; SDK status widget stays bespoke -->
        <div v-show="tab === 'runtime'" class="glass p-5">
          <h3 class="mb-1 text-sm font-semibold text-slate-200">Agent runtime</h3>
          <p class="mb-4 text-[12px] text-slate-500">{{ section('runtime').desc }}</p>
          <template v-if="rt">
            <div class="mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-white/5 bg-black/20 p-3">
              <div class="min-w-0">
                <div class="text-[11px] uppercase tracking-wide text-slate-500">Agent SDK</div>
                <div class="font-mono text-sm text-slate-200">{{ rt.sdk.installed || '—' }}
                  <span v-if="rt.sdk.latest && !rt.sdk.updateAvailable" class="ml-1 text-[11px] text-emerald-400"><AppIcon glyph="✓" /> up to date</span>
                  <span v-else-if="rt.sdk.updateAvailable" class="ml-1 text-[11px] text-amber-400">→ {{ rt.sdk.latest }} available</span>
                </div>
              </div>
              <button
                type="button"
                :disabled="busy === 'update' || !rt.sdk.updateAvailable"
                class="ml-auto rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40"
                :class="rt.sdk.updateAvailable ? 'border-amber-400/30 bg-amber-400/10 text-amber-300 hover:bg-amber-400/20' : 'border-white/10 bg-white/5 text-slate-500'"
                @click="updateSdk"
              >{{ busy === 'update' ? 'starting…' : (rt.sdk.updateAvailable ? 'Update now' : 'Latest') }}<AppIcon v-if="busy !== 'upd-run' && busy !== 'update'" glyph="↑" class="ml-1" /></button>
            </div>
            <label class="mb-5 flex cursor-pointer items-center justify-between gap-3">
              <span>
                <span class="text-sm text-slate-200">{{ field('runtime','autoUpdate').label }}</span>
                <span class="block text-[12px] text-slate-500">{{ field('runtime','autoUpdate').desc }}</span>
              </span>
              <button type="button" :disabled="busy === 'auto'" class="relative h-6 w-11 shrink-0 rounded-full transition-colors" :class="rt.autoUpdate ? 'bg-brand-violet' : 'bg-white/15'" @click="toggleAuto">
                <span class="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all" :class="rt.autoUpdate ? 'left-[22px]' : 'left-0.5'"></span>
              </button>
            </label>
            <label class="mb-5 flex cursor-pointer items-center justify-between gap-3">
              <span>
                <span class="text-sm text-slate-200">{{ field('runtime','cliBypass').label }}</span>
                <span class="block text-[12px] text-slate-500">{{ field('runtime','cliBypass').desc }}</span>
              </span>
              <button type="button" :disabled="busy === 'cli-bypass'" class="relative h-6 w-11 shrink-0 rounded-full transition-colors" :class="rt.cliBypass ? 'bg-brand-violet' : 'bg-white/15'" @click="toggleCliBypass">
                <span class="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all" :class="rt.cliBypass ? 'left-[22px]' : 'left-0.5'"></span>
              </button>
            </label>
            <div>
              <div class="mb-1.5 text-[11px] uppercase tracking-wide text-slate-500">{{ field('runtime','model').label }}
                <span v-if="rt.model.resolved" class="ml-1 font-mono text-slate-400">· running {{ rt.model.resolved }}</span>
              </div>
              <div class="flex flex-wrap gap-2">
                <button v-for="c in modelChoices" :key="c.id"
                  type="button" :disabled="busy === 'model'"
                  class="rounded-lg border px-3 py-2 text-left text-xs transition-colors"
                  :class="isChoice(c.id) ? 'border-brand-violet/60 bg-brand-violet/15 text-violet-200' : 'border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/10'"
                  @click="pickModel(c.id)">
                  <div class="font-semibold">{{ c.label }}</div>
                  <div class="text-[10px] text-slate-500">{{ c.hint }}</div>
                </button>
              </div>
              <div v-if="field('runtime','model').allowCustom" class="mt-2 flex items-center gap-2">
                <input v-model="customModel" type="text" placeholder="or a full model id (e.g. claude-opus-4-8)"
                  class="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 font-mono text-xs text-slate-100 outline-none focus:border-brand-violet/60"
                  @keydown.enter.prevent="setCustom" />
                <button type="button" :disabled="!customModel.trim() || busy === 'model'" class="shrink-0 rounded-lg bg-brand-gradient px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40" @click="setCustom">Set</button>
              </div>
            </div>
          </template>
          <p v-else class="py-3 text-center text-sm text-slate-500">loading…</p>
        </div>

        <!-- Updates — toggle copy from the manifest; changelog/status stays bespoke -->
        <div v-show="tab === 'updates'" class="glass p-5">
          <h3 class="mb-1 text-sm font-semibold text-slate-200">Updates</h3>
          <p class="mb-4 text-[12px] text-slate-500">{{ section('updates').desc }}</p>
          <template v-if="upd">
            <!-- release channel -->
            <div class="mb-3 flex items-center justify-between gap-3">
              <div>
                <span class="text-sm text-slate-200">Release channel</span>
                <span class="block text-[12px] text-slate-500">Stable pins to the newest release tag; edge tracks the latest commit.</span>
              </div>
              <div class="flex shrink-0 gap-1 rounded-lg border border-white/10 bg-white/[0.03] p-0.5">
                <button v-for="ch in ['stable','edge']" :key="ch" type="button" :disabled="busy === 'upd-channel'"
                  class="rounded-md px-3 py-1 text-xs font-medium transition-colors"
                  :class="updChannel === ch ? 'bg-brand-violet/25 text-violet-200' : 'text-slate-400 hover:text-slate-200'"
                  @click="setChannel(ch)">{{ ch }}</button>
              </div>
            </div>
            <div class="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-white/5 bg-black/20 p-3">
              <div class="min-w-0">
                <div class="text-[11px] uppercase tracking-wide text-slate-500">Version <span class="normal-case text-slate-600">· {{ upd.channel }}</span></div>
                <div class="font-mono text-sm text-slate-200">v{{ upd.version || '?' }} <span class="text-slate-500">({{ upd.head || '—' }})</span>
                  <span v-if="!upd.available" class="ml-1 text-[11px] text-emerald-400"><AppIcon glyph="✓" /> up to date</span>
                  <span v-else class="ml-1 text-[11px] text-amber-400">→ {{ upd.behind }} behind{{ upd.latest_version ? ' · v' + upd.latest_version : '' }} ({{ upd.remote }})</span>
                </div>
              </div>
              <button
                type="button"
                :disabled="busy === 'upd-run' || !upd.available"
                class="ml-auto rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40"
                :class="upd.available ? 'border-amber-400/30 bg-amber-400/10 text-amber-300 hover:bg-amber-400/20' : 'border-white/10 bg-white/5 text-slate-500'"
                @click="runUpdate"
              >{{ busy === 'upd-run' ? 'starting…' : (upd.available ? 'Update now' : 'Latest') }}<AppIcon v-if="busy !== 'upd-run' && busy !== 'update'" glyph="↑" class="ml-1" /></button>
            </div>
            <div v-if="upd.available && upd.changelog?.length" class="mb-4 max-h-40 overflow-y-auto rounded-lg border border-white/5 bg-black/20 p-3">
              <div class="mb-1 text-[11px] uppercase tracking-wide text-slate-500">Incoming ({{ upd.behind }})</div>
              <div v-for="(c, i) in upd.changelog" :key="i" class="truncate font-mono text-[11px] text-slate-400">{{ c }}</div>
            </div>
            <label class="flex cursor-pointer items-center justify-between gap-3">
              <span>
                <span class="text-sm text-slate-200">{{ field('updates','auto').label }}</span>
                <span class="block text-[12px] text-slate-500">{{ field('updates','auto').desc }}</span>
              </span>
              <button type="button" :disabled="busy === 'upd-auto'" class="relative h-6 w-11 shrink-0 rounded-full transition-colors" :class="updAuto ? 'bg-brand-violet' : 'bg-white/15'" @click="toggleUpdAuto">
                <span class="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all" :class="updAuto ? 'left-[22px]' : 'left-0.5'"></span>
              </button>
            </label>
          </template>
          <p v-else class="py-3 text-center text-sm text-slate-500">loading…</p>
        </div>

        <!-- Voice — ack toggle + TTS voice/model + STT model, all sourced from the manifest -->
        <div v-show="tab === 'voice'" class="glass p-5">
          <h3 class="mb-1 text-sm font-semibold text-slate-200">Voice</h3>
          <p class="mb-4 text-[12px] text-slate-500">{{ section('voice').desc }}</p>
          <label class="mb-5 flex cursor-pointer items-center justify-between gap-3">
            <span>
              <span class="text-sm text-slate-200">{{ field('voice','ack').label }}</span>
              <span class="block text-[12px] text-slate-500">{{ field('voice','ack').desc }}</span>
            </span>
            <button type="button" class="relative h-6 w-11 shrink-0 rounded-full transition-colors" :class="ackOn ? 'bg-brand-violet' : 'bg-white/15'" @click="toggleAck">
              <span class="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all" :class="ackOn ? 'left-[22px]' : 'left-0.5'"></span>
            </button>
          </label>

          <template v-if="vcfg">
            <!-- TTS provider -->
            <div class="mb-5">
              <div class="mb-1.5 text-[11px] uppercase tracking-wide text-slate-500">{{ field('voice','tts_provider').label }}
                <span class="normal-case text-slate-600">— {{ field('voice','tts_provider').desc }}</span>
              </div>
              <div class="flex flex-wrap gap-2">
                <button v-for="c in ttsProviderChoices" :key="c.id" type="button" :disabled="busy === 'voicecfg'"
                  class="rounded-lg border px-3 py-2 text-left text-xs transition-colors"
                  :class="vcfg.tts?.provider === c.id ? 'border-brand-violet/60 bg-brand-violet/15 text-violet-200' : 'border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/10'"
                  @click="setVoiceCfg({ tts: { provider: c.id } })">
                  <div class="font-semibold">{{ c.label }}</div>
                  <div class="text-[10px] text-slate-500">{{ c.hint }}</div>
                </button>
              </div>
            </div>

            <!-- TTS voice -->
            <div class="mb-5">
              <div class="mb-1.5 text-[11px] uppercase tracking-wide text-slate-500">{{ field('voice','tts_voice').label }}
                <span class="normal-case text-slate-600">— {{ field('voice','tts_voice').desc }}</span>
              </div>
              <div class="flex flex-wrap gap-2">
                <button v-for="c in ttsVoiceChoices" :key="c.id" type="button" :disabled="busy === 'voicecfg'"
                  class="rounded-lg border px-3 py-2 text-left text-xs transition-colors"
                  :class="vcfg.tts?.voice === c.id ? 'border-brand-violet/60 bg-brand-violet/15 text-violet-200' : 'border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/10'"
                  @click="setVoiceCfg({ tts: { voice: c.id } })">
                  <div class="font-semibold">{{ c.label }}</div>
                  <div class="text-[10px] text-slate-500">{{ c.hint }}</div>
                </button>
              </div>
              <div v-if="field('voice','tts_voice').allowCustom" class="mt-2 flex items-center gap-2">
                <input v-model="customVoice" type="text" placeholder="or another voice id"
                  class="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 font-mono text-xs text-slate-100 outline-none focus:border-brand-violet/60"
                  @keydown.enter.prevent="setCustomVoice" />
                <button type="button" :disabled="!customVoice.trim() || busy === 'voicecfg'" class="shrink-0 rounded-lg bg-brand-gradient px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40" @click="setCustomVoice">Set</button>
              </div>
            </div>

            <!-- TTS model -->
            <div class="mb-5">
              <div class="mb-1.5 text-[11px] uppercase tracking-wide text-slate-500">{{ field('voice','tts_model').label }}
                <span class="normal-case text-slate-600">— {{ field('voice','tts_model').desc }}</span>
              </div>
              <div class="flex flex-wrap gap-2">
                <button v-for="c in ttsModelChoices" :key="c.id" type="button" :disabled="busy === 'voicecfg'"
                  class="rounded-lg border px-3 py-2 text-left text-xs transition-colors"
                  :class="vcfg.tts?.model === c.id ? 'border-brand-violet/60 bg-brand-violet/15 text-violet-200' : 'border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/10'"
                  @click="setVoiceCfg({ tts: { model: c.id } })">
                  <div class="font-semibold">{{ c.label }}</div>
                  <div class="text-[10px] text-slate-500">{{ c.hint }}</div>
                </button>
              </div>
              <div v-if="field('voice','tts_model').allowCustom" class="mt-2 flex items-center gap-2">
                <input v-model="customTtsModel" type="text" placeholder="or another model id (e.g. eleven_turbo_v2_5)"
                  class="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 font-mono text-xs text-slate-100 outline-none focus:border-brand-violet/60"
                  @keydown.enter.prevent="setCustomTtsModel" />
                <button type="button" :disabled="!customTtsModel.trim() || busy === 'voicecfg'" class="shrink-0 rounded-lg bg-brand-gradient px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40" @click="setCustomTtsModel">Set</button>
              </div>
            </div>

            <!-- STT model -->
            <div>
              <div class="mb-1.5 text-[11px] uppercase tracking-wide text-slate-500">{{ field('voice','stt_model').label }}
                <span class="normal-case text-slate-600">— {{ field('voice','stt_model').desc }}</span>
              </div>
              <div class="flex flex-wrap gap-2">
                <button v-for="c in sttModelChoices" :key="c.id" type="button" :disabled="busy === 'voicecfg'"
                  class="rounded-lg border px-3 py-2 text-left text-xs transition-colors"
                  :class="vcfg.stt?.model === c.id ? 'border-brand-violet/60 bg-brand-violet/15 text-violet-200' : 'border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/10'"
                  @click="setVoiceCfg({ stt: { model: c.id } })">
                  <div class="font-semibold">{{ c.label }}</div>
                  <div class="text-[10px] text-slate-500">{{ c.hint }}</div>
                </button>
              </div>
            </div>
          </template>
        </div>

        <!-- Notifications — GUI-only (browser Notification API); the ✦ Notifications page shows history -->
        <div v-show="tab === 'notifications'" class="glass p-5">
          <h3 class="mb-1 text-sm font-semibold text-slate-200">Notifications</h3>
          <p class="mb-4 text-[12px] text-slate-500">Desktop/mobile alerts from this browser when a session turn completes — so you know a reply is ready while you're on another tab.</p>
          <label class="flex cursor-pointer items-center justify-between gap-3">
            <span>
              <span class="text-sm text-slate-200">Notify me when a turn completes</span>
              <span class="block text-[12px] text-slate-500">
                <template v-if="!notifySupported">This browser doesn't support notifications.</template>
                <template v-else-if="notifyPerm === 'denied'">Blocked in the browser — allow notifications for this site to enable.</template>
                <template v-else>Fires a notification for each completed reply (skips the web chats you're already viewing).</template>
              </span>
            </span>
            <button type="button" class="relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40"
              :class="notifyOn ? 'bg-brand-violet' : 'bg-white/15'"
              :disabled="!notifySupported || notifyPerm === 'denied'" @click="toggleNotify">
              <span class="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all" :class="notifyOn ? 'left-[22px]' : 'left-0.5'"></span>
            </button>
          </label>
          <RouterLink to="/notifications" class="mt-4 inline-flex items-center gap-1.5 text-[12px] text-brand-violet hover:underline">
            <AppIcon glyph="✦" /> View notification history
          </RouterLink>
        </div>

        <p v-if="notice" class="mt-4 text-center text-[12px] text-slate-400">{{ notice }}</p>
      </template>
    </div>
  </div>
</template>
