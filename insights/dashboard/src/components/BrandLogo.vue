<script setup>
// The asmltr mark as INLINE svg (not an <img src>) so its gradient can reference the live brand CSS
// vars (--brand-violet / --brand-pink) — it retints with the identity palette in real time. `class`
// from the parent falls through to the root <svg> for sizing.
</script>

<template>
  <svg
    viewBox="0 0 64 64" fill="none" role="img" aria-label="brand" xmlns="http://www.w3.org/2000/svg"
    style="filter: drop-shadow(0 2px 8px rgb(var(--brand-violet) / 0.35))"
  >
    <defs>
      <linearGradient id="brandLogoGrad" x1="6" y1="4" x2="58" y2="60" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="rgb(var(--brand-violet))" />
        <stop offset="1" stop-color="rgb(var(--brand-pink))" />
      </linearGradient>
    </defs>
    <g stroke="url(#brandLogoGrad)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M32 16V9" />
      <circle cx="32" cy="6" r="2.4" fill="url(#brandLogoGrad)" stroke="none" />
      <path d="M27.6 5.6a7 7 0 0 0-2.3 3.5" opacity=".4" />
      <path d="M36.4 5.6a7 7 0 0 1 2.3 3.5" opacity=".4" />
      <rect x="13" y="16" width="38" height="34" rx="9" />
      <path d="M13 28H9M13 38H9M51 28h4M51 38h4" opacity=".65" />
      <circle cx="24" cy="30" r="3.4" />
      <circle cx="40" cy="30" r="3.4" />
      <circle cx="24" cy="30" r=".9" fill="url(#brandLogoGrad)" stroke="none" />
      <circle cx="40" cy="30" r=".9" fill="url(#brandLogoGrad)" stroke="none" />
      <path d="M23 40.5v3M27 39v6M31 37.5v9M35 39.5v5M39 38.5v7" />
    </g>
  </svg>
</template>
