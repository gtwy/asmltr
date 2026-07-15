<script setup>
// Talk to THE OBSERVER — the conversational face of proprioception. A chat with Eve reflecting on
// herself as a WHOLE (not any one working session), grounded in the live body-schema + the reflector's
// deduced goal. It's a normal web-chat session (browser-as-connector, streams through the core) on a
// persistent `self-observer` key, but each turn we inject a fresh snapshot of the body as system-prompt
// context — so the observer always knows its current parts — and frame it to guide (announce), not command.
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'
import { webChat, identity, api } from '@/services/api'

// Self-contained: fetch the live body-schema + assessment ourselves (this can be rendered anywhere,
// e.g. a floating window), and poll so the injected context stays current. The dashboard is viewed
// by the OPERATOR, so the chrome refers to the assistant by name (it's the assistant's whole self).
const name = ref('the assistant')
const schema = ref(null)
const assessment = ref(null)
let poll = null
async function refresh() {
  try { schema.value = await api.selfSchema() } catch (_) {}
  try { assessment.value = await api.selfAssessment() } catch (_) {}
}
onMounted(() => {
  identity.get().then((d) => { if (d && d.name) name.value = d.name }).catch(() => {})
  refresh(); poll = setInterval(refresh, 20000)
})
onUnmounted(() => clearInterval(poll))

const KEY = 'eve-assistant-web:self-observer'
const messages = ref([])          // { role: 'user'|'assistant', text, tools?: [] }
const draft = ref('')
const busy = ref(false)
const scrollBox = ref(null)
let ac = null

function scrollDown() { nextTick(() => { const el = scrollBox.value; if (el) el.scrollTop = el.scrollHeight }) }

// A compact, always-current snapshot of the body — injected each turn so the observer is grounded.
function bodyContext() {
  const s = schema.value
  const latest = assessment.value?.latest
  const lines = ['[YOU ARE THE OBSERVER — proprioception]',
    'You are reflecting on yourself AS A WHOLE — the observer of all your working sessions, not any single one. You are being asked about your overall state. Speak as the whole ("I have N parts working on…"), and be honest about what you observe.']
  if (s?.nodes?.length) {
    lines.push('', `YOUR BODY RIGHT NOW — ${s.nodes.length} part(s):`)
    for (const n of s.nodes.slice(0, 40)) {
      const what = n.activity || n.title || '(idle)'
      const repo = n.repo ? ` · ${n.repo.split('/').slice(-1)[0]}` : ''
      const age = n.age_min <= 1 ? 'now' : `${n.age_min}m ago`
      lines.push(`- [${n.surface}] ${what}${repo} · active ${age}`)
    }
    const edges = (s.edges || []).map((e) => `${e.kind}`)
    if (edges.length) lines.push(`STRUCTURAL LINKS: ${s.edges.length} (same-repo / announced-to)`)
  } else {
    lines.push('', 'YOUR BODY RIGHT NOW: at rest (no active parts).')
  }
  if (latest?.goal) {
    lines.push('', `DEDUCED GOAL (your reflector's last read): ${latest.goal}`)
    if (latest.threads?.length) lines.push(`THREADS: ${latest.threads.join(' · ')}`)
    if (latest.flags?.length) lines.push(`FLAGS: ${latest.flags.join(' · ')}`)
  }
  lines.push('',
    'To look deeper or act, use the asmltr CLI via Bash: `asmltr ls` / `asmltr map` (what each part is doing) · ' +
    '`asmltr who <path>` (who touched a file) · `asmltr announce "<text>" [--to <target>]` to put an awareness note ' +
    'into a part\'s next turn. GUIDE, don\'t command — prefer announce over steer; the parts decide for themselves. ' +
    'Keep replies conversational.')
  return lines.join('\n')
}

async function send() {
  const text = draft.value.trim()
  if (!text || busy.value) return
  draft.value = ''
  messages.value.push({ role: 'user', text })
  const reply = { role: 'assistant', text: '', tools: [] }
  messages.value.push(reply)
  busy.value = true
  scrollDown()
  ac = webChat.send({ conversation_key: KEY, text, system_prompt_extra: bodyContext() }, {
    onDelta: (t) => { reply.text += t; scrollDown() },
    onTool: (name) => { if (!reply.tools.includes(name)) reply.tools.push(name); scrollDown() },
    onError: (e) => { reply.text += (reply.text ? '\n\n' : '') + `⚠️ ${e}`; busy.value = false },
    onDone: () => { busy.value = false; if (!reply.text.trim()) reply.text = '(no reply)'; scrollDown() }
  })
}
function stop() { try { ac && ac.abort() } catch (_) {} busy.value = false }

const placeholder = computed(() => schema.value?.nodes?.length
  ? `Ask ${name.value} about the whole — what's being worked on across all parts, what's stuck, what should converge?`
  : `${name.value} is at rest — no active parts. Ask about the overall state.`)
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div ref="scrollBox" class="min-h-0 flex-1 space-y-2.5 overflow-y-auto">
      <p v-if="!messages.length" class="py-6 text-center text-xs leading-relaxed text-slate-500">
        Talk to {{ name }} as a whole — the observer of all its sessions, grounded in the live parts and deduced goal.<br />
        Ask about the big picture; it can inspect parts and send them awareness notes.
      </p>
      <div v-for="(m, i) in messages" :key="i" :class="m.role === 'user' ? 'flex justify-end' : ''">
        <div v-if="m.role === 'user'" class="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm border border-brand-violet/30 bg-brand-violet/15 px-3 py-2 text-[13px] leading-snug text-violet-100">{{ m.text }}</div>
        <div v-else class="max-w-[92%]">
          <div v-if="m.tools?.length" class="mb-1 flex flex-wrap gap-1">
            <span v-for="t in m.tools" :key="t" class="pill border border-white/10 bg-white/5 text-[10px] text-slate-400">🔧 {{ t }}</span>
          </div>
          <div class="whitespace-pre-wrap break-words rounded-2xl rounded-bl-sm border border-white/10 bg-white/[0.04] px-3 py-2 text-[13px] leading-snug text-slate-200">{{ m.text || '…' }}</div>
        </div>
      </div>
    </div>

    <div class="mt-2 flex items-center gap-2 border-t border-white/5 pt-2.5">
      <button v-if="messages.length" class="shrink-0 rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-xs text-slate-500 hover:text-slate-300" title="Clear conversation" @click="messages = []">clear</button>
      <input v-model="draft" type="text" :placeholder="placeholder"
             class="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-brand-violet/50"
             @keydown.enter.prevent="send" />
      <button v-if="!busy" class="rounded-lg bg-brand-gradient px-4 py-2 text-sm font-semibold text-white disabled:opacity-40" :disabled="!draft.trim()" @click="send">Send</button>
      <button v-else class="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-300" @click="stop">Stop</button>
    </div>
  </div>
</template>
