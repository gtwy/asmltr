<script setup>
// A draggable + resizable floating window (no modal backdrop, so the page stays usable
// underneath). Drag by the header, resize from the bottom-right grip. Position + size are
// persisted per `storageKey` so reopening lands where you left it. Pointer events cover
// mouse + touch. Layout is a flex column: header (drag) · body slot (fills, scrolls) · footer.
import { ref, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({
  title: { type: String, default: '' },
  subtitle: { type: String, default: '' },
  storageKey: { type: String, default: 'asmltr:floatwin' },
  minW: { type: Number, default: 380 },
  minH: { type: Number, default: 320 }
})
const emit = defineEmits(['close'])

const DEFAULT = { w: 660, h: 580 }
const pos = ref({ x: 0, y: 0 })
const size = ref({ ...DEFAULT })

function clamp() {
  const vw = window.innerWidth, vh = window.innerHeight
  size.value.w = Math.min(Math.max(size.value.w, props.minW), vw - 16)
  size.value.h = Math.min(Math.max(size.value.h, props.minH), vh - 16)
  pos.value.x = Math.min(Math.max(pos.value.x, 8), Math.max(8, vw - size.value.w - 8))
  pos.value.y = Math.min(Math.max(pos.value.y, 8), Math.max(8, vh - size.value.h - 8))
}
function persist() {
  try { localStorage.setItem(props.storageKey, JSON.stringify({ ...pos.value, ...size.value })) } catch (_) {}
}

onMounted(() => {
  let saved = null
  try { saved = JSON.parse(localStorage.getItem(props.storageKey) || 'null') } catch (_) {}
  if (saved && Number.isFinite(saved.x)) {
    pos.value = { x: saved.x, y: saved.y }
    size.value = { w: saved.w || DEFAULT.w, h: saved.h || DEFAULT.h }
  } else {
    // first open: center in the viewport
    size.value = { w: Math.min(DEFAULT.w, window.innerWidth - 24), h: Math.min(DEFAULT.h, window.innerHeight - 24) }
    pos.value = { x: Math.max(8, (window.innerWidth - size.value.w) / 2), y: Math.max(8, (window.innerHeight - size.value.h) / 2) }
  }
  clamp()
  window.addEventListener('resize', clamp)
})
onBeforeUnmount(() => window.removeEventListener('resize', clamp))

// --- drag --------------------------------------------------------------------
let mode = null // 'drag' | 'resize'
let start = null
function onDown(m, ev) {
  if (ev.button != null && ev.button !== 0) return
  mode = m
  start = { px: ev.clientX, py: ev.clientY, x: pos.value.x, y: pos.value.y, w: size.value.w, h: size.value.h }
  document.body.style.userSelect = 'none'
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}
function onMove(ev) {
  if (!mode || !start) return
  const dx = ev.clientX - start.px, dy = ev.clientY - start.py
  if (mode === 'drag') { pos.value = { x: start.x + dx, y: start.y + dy } }
  else { size.value = { w: start.w + dx, h: start.h + dy } }
  clamp()
}
function onUp() {
  mode = null; start = null
  document.body.style.userSelect = ''
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
  persist()
}

function onKey(e) { if (e.key === 'Escape') emit('close') }
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div
      class="glass fixed z-[70] flex flex-col overflow-hidden shadow-2xl shadow-black/50"
      :style="{ left: pos.x + 'px', top: pos.y + 'px', width: size.w + 'px', height: size.h + 'px' }"
    >
      <!-- header (drag handle) -->
      <header
        class="flex shrink-0 cursor-move touch-none items-start justify-between gap-3 border-b border-white/10 px-4 py-3"
        @pointerdown="onDown('drag', $event)"
      >
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="select-none text-slate-600">⠿</span>
            <slot name="title">
              <h2 class="truncate text-base font-bold tracking-tight"><span class="gradient-text">{{ title }}</span></h2>
            </slot>
          </div>
          <p v-if="subtitle" class="mt-0.5 truncate font-mono text-[11px] text-slate-500">{{ subtitle }}</p>
        </div>
        <button
          type="button"
          class="shrink-0 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-sm text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-200"
          title="Close"
          @pointerdown.stop
          @click="emit('close')"
        >✕</button>
      </header>

      <!-- body (fills remaining height; child manages its own scroll) -->
      <div class="flex min-h-0 flex-1 flex-col px-4 py-3">
        <slot />
      </div>

      <!-- footer -->
      <footer v-if="$slots.footer" class="shrink-0 border-t border-white/10 px-4 py-3">
        <slot name="footer" />
      </footer>

      <!-- resize grip -->
      <div
        class="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize touch-none"
        title="Drag to resize"
        @pointerdown="onDown('resize', $event)"
      >
        <svg viewBox="0 0 10 10" class="h-full w-full text-slate-600"><path d="M9 1 L1 9 M9 5 L5 9" stroke="currentColor" stroke-width="1" fill="none"/></svg>
      </div>
    </div>
  </Teleport>
</template>
