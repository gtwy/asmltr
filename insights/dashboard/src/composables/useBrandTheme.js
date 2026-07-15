// Live UI theming from the identity "signature colors" palette. The dashboard's brand accent +
// gradient are CSS vars (--brand-violet / --brand-pink as "r g b" channels; see main.css +
// tailwind.config). We set the primary signature color as the accent and the secondary as the
// gradient's far end, so saving a palette in Settings → Identity retints the whole UI in real time.

// Resolve any CSS color (hex OR name like "slate"/"orange") to "r g b" channels via the browser.
function toChannels(color) {
  if (!color || typeof document === 'undefined') return null
  const el = document.createElement('span')
  el.style.color = ''
  el.style.color = color // invalid values are rejected → style.color stays ''
  if (!el.style.color) return null
  el.style.display = 'none'
  document.body.appendChild(el)
  const computed = getComputedStyle(el).color
  el.remove()
  const m = computed.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/)
  return m ? `${m[1]} ${m[2]} ${m[3]}` : null
}

// One palette entry ("orange #FF6600" / "#FF6600" / "slate") → the color token to resolve (prefer hex).
function entryColor(entry) {
  const m = String(entry).match(/#?\b[0-9a-fA-F]{6}\b|#?\b[0-9a-fA-F]{3}\b/)
  if (m) return m[0][0] === '#' ? m[0] : '#' + m[0]
  const name = String(entry).replace(/[()]/g, '').trim()
  return name || null
}

// Parse the raw palette string into resolved [primaryChannels, secondaryChannels, …] (skips unresolvable).
function paletteChannels(raw) {
  if (!raw) return []
  return String(raw)
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((e) => toChannels(entryColor(e)))
    .filter(Boolean)
}

// Apply a palette string to the live theme. Empty/unresolvable → revert to the CSS defaults.
export function applyPalette(raw) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const ch = paletteChannels(raw)
  if (!ch.length) {
    root.style.removeProperty('--brand-violet')
    root.style.removeProperty('--brand-pink')
    return
  }
  root.style.setProperty('--brand-violet', ch[0]) // primary → accent
  root.style.setProperty('--brand-pink', ch[1] || ch[0]) // secondary → gradient far end (else reuse primary)
}

export function useBrandTheme() {
  return { applyPalette }
}
