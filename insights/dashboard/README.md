# asmltr-insights · dashboard

A **read-only** Vue 3 observability dashboard over the `asmltr` collector — the
single pane of glass for every agent session, event, token, and host sample the
collector records.

> Read-only by design. The "KILL" button on session cards is intentionally
> rendered-but-disabled; the control plane (Phase 4) does not exist yet and this
> UI never POSTs anything.

## Stack

- **Vue 3** (`<script setup>` SFCs) + **Vite**
- **Pinia** — a single `collector` store wraps REST + the live socket
- **vue-router** — Live / Timeline / Usage / System / Notifications
- **Tailwind CSS** — mobile-first, dark glassmorphism, purple gradient `#8B5CF6 → #EC4899`
- **socket.io-client** — live event / system-sample / sessions-changed streams
- **ECharts** via **vue-echarts** (tree-shaken: line + bar only)

## Running it

The collector must be live at `http://127.0.0.1:3017` (it already is in dev). The
Vite dev server proxies `/api` and `/socket.io` to it — no CORS, no token, no
config to touch.

```bash
cd insights/dashboard
npm install
npm run dev        # → http://127.0.0.1:5173  (proxies to the collector on :3017)
```

Production build (static SPA, output in `dist/`):

```bash
npm run build
npm run preview    # serve the build locally to sanity-check
```

> Note: `npm run preview` serves the static build but does **not** proxy to the
> collector — use `npm run dev` for live data, or front `dist/` with a reverse
> proxy that forwards `/api` + `/socket.io` to `:3017` (the later your auth proxy
> phase).

## How data flows

```
collector :3017  ──REST──►  services/api.js  ──►  stores/collector.js  ──►  views
       │                                              ▲
       └──────────socket.io──►  services/socket.js ───┘   (live append)
```

- **REST** payloads arrive as JSON **strings** → `parsePayload()` parses them.
- **Socket** payloads arrive as **objects** already → stored as-is.
- All timestamps are **unix milliseconds**.
- The store keeps bounded in-memory buffers (1000 events, 500 samples) and a
  30s safety-net poll for session/brief data on top of the socket pushes.

## Pages

| Route            | What it shows |
|------------------|---------------|
| `/` Live         | Session cards (ephemeral + persistent daemons), surface badges, age, token burn, status dot, multiplexer/claim indicators, disabled KILL stub. |
| `/timeline`      | Unified reverse-chronological cross-surface event feed; surface/identity filter chips + search; live-appends from the socket. |
| `/usage`         | "Token usage + attribution" — stacked area by surface, bar by surface, per-identity table. `$` column only when `cost_usd > 0`. Framed as *attributed, not billed* for Max-plan surfaces. |
| `/system`        | Live CPU %, load 1/5, memory, disk-used charts + current stat tiles (CPU, mem, disk-used %, disk-free GB). |
| `/notifications` | Feed of outbound notifications. |

## File tree

```
src/
  main.js
  App.vue                      # shell: nav + connection status, owns socket lifecycle
  router/index.js
  stores/collector.js          # Pinia: REST + socket + buffers
  services/
    api.js                     # fetch wrapper + parsePayload
    socket.js                  # shared socket.io connection
  lib/format.js                # surface/event/status meta + time/number formatters
  components/
    SurfaceBadge.vue
    StatTile.vue
    SessionCard.vue
    TimelineRow.vue
    PageHeader.vue
    charts/BaseChart.vue       # tree-shaken vue-echarts wrapper
  views/
    Live.vue  Timeline.vue  Usage.vue  System.vue  Notifications.vue
  assets/main.css              # tailwind + glass/gradient utilities
```
