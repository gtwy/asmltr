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

const DEFAULT_VIOLET = '139 92 246'
const DEFAULT_PINK = '236 72 153'

// The tab-bar favicon can't read page CSS vars (it's browser chrome), so we bake the resolved colors
// into an SVG data-URI and swap the <link rel="icon"> href whenever the palette changes.
function faviconDataUri(vCh, pCh) {
  const rgb = (ch) => `rgb(${ch.trim().split(/\s+/).join(',')})`
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">` +
    `<defs><linearGradient id="g" x1="6" y1="4" x2="58" y2="60" gradientUnits="userSpaceOnUse">` +
    `<stop offset="0" stop-color="${rgb(vCh)}"/><stop offset="1" stop-color="${rgb(pCh)}"/></linearGradient></defs>` +
    `<g stroke="url(#g)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M32 16V9"/><circle cx="32" cy="6" r="2.4" fill="url(#g)" stroke="none"/>` +
    `<path d="M27.6 5.6a7 7 0 0 0-2.3 3.5" opacity=".4"/><path d="M36.4 5.6a7 7 0 0 1 2.3 3.5" opacity=".4"/>` +
    `<rect x="13" y="16" width="38" height="34" rx="9"/><path d="M13 28H9M13 38H9M51 28h4M51 38h4" opacity=".65"/>` +
    `<circle cx="24" cy="30" r="3.4"/><circle cx="40" cy="30" r="3.4"/>` +
    `<circle cx="24" cy="30" r=".9" fill="url(#g)" stroke="none"/><circle cx="40" cy="30" r=".9" fill="url(#g)" stroke="none"/>` +
    `<path d="M23 40.5v3M27 39v6M31 37.5v9M35 39.5v5M39 38.5v7"/></g></svg>`
  return 'data:image/svg+xml,' + encodeURIComponent(svg)
}

function updateFavicon(vCh, pCh) {
  let link = document.querySelector('link[rel="icon"]')
  if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link) }
  link.type = 'image/svg+xml'
  link.href = faviconDataUri(vCh, pCh)
}

// Apply a palette string to the live theme (in-page CSS vars + the tab favicon). Empty/unresolvable
// → revert to the built-in violet/pink defaults.
export function applyPalette(raw) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const ch = paletteChannels(raw)
  const v = ch[0] || DEFAULT_VIOLET // primary → accent
  const p = ch[1] || ch[0] || DEFAULT_PINK // secondary → gradient far end (else reuse primary)
  if (ch.length) {
    root.style.setProperty('--brand-violet', v)
    root.style.setProperty('--brand-pink', p)
  } else {
    root.style.removeProperty('--brand-violet')
    root.style.removeProperty('--brand-pink')
  }
  updateFavicon(v, p)
}

export function useBrandTheme() {
  return { applyPalette }
}
