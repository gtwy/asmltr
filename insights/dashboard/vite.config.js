import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

const COLLECTOR = 'http://127.0.0.1:3017'
const MANAGER = 'http://127.0.0.1:3024'
const TRUST = 'http://127.0.0.1:3023'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: COLLECTOR,
        changeOrigin: true
      },
      // connector manager (control plane). The manager serves its routes at the
      // root (/types, /instances, ...), so strip the /manager prefix here. No
      // auth in dev — the manager runs open on localhost.
      '/manager': {
        target: MANAGER,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/manager/, '')
      },
      // trust framework (the Access control plane) on the CORE. Like the
      // collector's /api, the core serves these routes at the root under
      // /trust/... (e.g. /trust/principals), so there is NO prefix to strip.
      // No auth in dev — the core runs open on localhost.
      '/trust': {
        target: TRUST,
        changeOrigin: true
      },
      '/socket.io': {
        target: COLLECTOR,
        changeOrigin: true,
        ws: true
      }
    }
  }
})
