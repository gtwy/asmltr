<script setup>
// Talk to THE OBSERVER — the conversational face of proprioception. A chat with Eve reflecting on
// herself as a WHOLE (not any one working session), grounded in the live body-schema + the reflector's
// deduced goal. It's a normal web-chat session (browser-as-connector, streams through the core) on a
// persistent `self-observer` key, but each turn we inject a fresh snapshot of the body as system-prompt
// context — so the observer always knows its current parts — and frame it to guide (announce), not command.
import { ref, computed, nextTick } from 'vue'
import { webChat } from '@/services/api'
import { surfaceMeta, truncate } from '@/lib/format'

const props = defineProps({
  schema: { type: Object, default: null },     // { nodes, edges, counts }
  assessment: { type: Object, default: null }  // { latest: { goal, threads, flags } }
})

const KEY = 'eve-assistant-web:self-observer'
const messages = ref([])          // { role: 'user'|'assistant', text, tools?: [] }
const draft = ref('')
const busy = ref(false)
const scrollBox = ref(null)
let ac = null

function scrollDown() { nextTick(() => { const el = scrollBox.value; if (el) el.scrollTop = el.scrollHeight }) }

// A compact, always-current snapshot of the body — injected each turn so the observer is grounded.
function bodyContext() {
  const s = props.schema
  const latest = props.assessment?.latest
  const lines = ['[YOU ARE THE OBSERVER — proprioception]',
    'You are Eve reflecting on yourself AS A WHOLE — the observer of all your working sessions, not any single one. Jareth is talking to you here about your overall state. Speak as the whole ("I have N parts working on…"), be honest about what you observe.']
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

const placeholder = computed(() => props.schema?.nodes?.length
  ? 'Ask the observer about your whole self — what are you working on, what\'s stuck, what should converge?'
  : 'The body is at rest. Ask the observer anything about your overall state.')
</script>

<template>
  <div class="glass flex flex-col overflow-hidden">
    <div class="flex items-center justify-between border-b border-white/5 px-4 py-2.5">
      <div class="flex items-center gap-2">
        <span class="text-sm font-semibold text-slate-200">🧠 The Observer</span>
        <span class="text-[11px] text-slate-500">— talk to your whole self</span>
      </div>
      <button v-if="messages.length" class="text-[11px] text-slate-500 hover:text-slate-300" @click="messages = []">clear</button>
    </div>

    <div ref="scrollBox" class="min-h-[120px] flex-1 space-y-2.5 overflow-y-auto p-4" style="max-height: 340px">
      <p v-if="!messages.length" class="py-6 text-center text-xs leading-relaxed text-slate-500">
        This is you, reflecting on yourself as a whole — grounded in your live parts and deduced goal.<br />
        Ask about the big picture; the observer can inspect parts and send them awareness notes.
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

    <div class="flex items-center gap-2 border-t border-white/5 p-2.5">
      <input v-model="draft" type="text" :placeholder="placeholder"
             class="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-brand-violet/50"
             @keydown.enter.prevent="send" />
      <button v-if="!busy" class="rounded-lg bg-brand-gradient px-4 py-2 text-sm font-semibold text-white disabled:opacity-40" :disabled="!draft.trim()" @click="send">Send</button>
      <button v-else class="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-300" @click="stop">Stop</button>
    </div>
  </div>
</template>
