<script setup>
// Discord server membership for one connector instance: the OAuth invite URL to ADD the bot to a new
// server (adding is a Discord authorization, not a config change — an admin of the target authorizes
// the URL and the gateway sees the guild instantly), plus the guilds it's already in, each removable.
import { onMounted, ref } from 'vue'
import ModalShell from './ModalShell.vue'
import { manager } from '@/services/manager'

const props = defineProps({ instance: { type: Object, required: true } })
const emit = defineEmits(['close'])

const data = ref(null)
const loading = ref(false)
const error = ref(null)
const busy = ref('') // guildId being left
const copied = ref(false)

async function load() {
  loading.value = true; error.value = null
  try { data.value = await manager.servers(props.instance.id) }
  catch (e) { error.value = e.message } finally { loading.value = false }
}
async function copyInvite() {
  try { await navigator.clipboard.writeText(data.value.invite_url); copied.value = true; setTimeout(() => (copied.value = false), 1500) } catch (_) {}
}
async function leave(g) {
  if (!confirm(`Remove ${data.value.bot_name || 'the bot'} from “${g.name}”? It will leave the server.`)) return
  busy.value = g.id; error.value = null
  try { await manager.leaveServer(props.instance.id, g.id); await load() }
  catch (e) { error.value = e.message } finally { busy.value = '' }
}

onMounted(load)
</script>

<template>
  <ModalShell :title="`Discord servers · ${instance.name}`" :subtitle="instance.id" wide @close="emit('close')">
    <p v-if="error" class="mb-3 text-sm text-rose-400">{{ error }}</p>

    <!-- Add to a new server -->
    <div class="mb-4 rounded-xl border border-brand-violet/30 bg-brand-violet/10 p-3">
      <div class="mb-1 text-[11px] uppercase tracking-wide text-violet-300">Add to a server</div>
      <p class="mb-2 text-[12px] text-slate-400">Open this invite as someone with <b>Manage Server</b> on the target and authorize. The bot joins instantly — no restart.</p>
      <div v-if="data && data.invite_url" class="flex flex-wrap items-center gap-2">
        <input readonly :value="data.invite_url" class="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-[11px] text-slate-300" />
        <button type="button" class="glass glass-hover px-2.5 py-1.5 text-xs text-slate-200" @click="copyInvite"><AppIcon :name="['fas','paperclip']" /> {{ copied ? 'Copied' : 'Copy' }}</button>
        <a :href="data.invite_url" target="_blank" rel="noopener" class="rounded-lg bg-brand-gradient px-3 py-1.5 text-xs font-semibold text-white">Open ↗</a>
      </div>
      <p v-else-if="loading" class="text-[12px] text-slate-500">Loading…</p>
    </div>

    <!-- Current servers -->
    <div class="text-[11px] uppercase tracking-wide text-slate-500 mb-2">Member of {{ data && data.servers ? data.servers.length : 0 }} server(s)</div>
    <div v-if="data && data.servers && data.servers.length" class="flex flex-col gap-1.5 max-h-[38vh] overflow-y-auto">
      <div v-for="g in data.servers" :key="g.id" class="flex items-center gap-3 rounded-lg border border-white/5 bg-white/[0.03] px-3 py-1.5">
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm text-slate-200">{{ g.name }}</div>
          <div class="font-mono text-[10px] text-slate-600">{{ g.id }}<span v-if="g.member_count != null"> · {{ g.member_count }} members</span></div>
        </div>
        <button type="button" class="rounded-lg border border-rose-500/20 bg-rose-500/5 px-2.5 py-1 text-xs text-rose-400/80 hover:bg-rose-500/15 disabled:opacity-50" :disabled="busy === g.id" @click="leave(g)">
          {{ busy === g.id ? 'Leaving…' : 'Leave' }}
        </button>
      </div>
    </div>
    <p v-else-if="!loading" class="text-sm text-slate-600">Not in any servers yet.</p>

    <template #footer>
      <button type="button" :disabled="loading" class="glass glass-hover px-3 py-1.5 text-sm text-slate-300 disabled:opacity-50" @click="load"><AppIcon glyph="↻" /> {{ loading ? 'Refreshing…' : 'Refresh' }}</button>
    </template>
  </ModalShell>
</template>
