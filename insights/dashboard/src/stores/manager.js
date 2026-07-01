// Pinia store for the connector manager (control plane). Unlike the collector
// store this one is read/write: it creates, edits, and lifecycle-controls
// connector instances. It owns its own ~3s poll of /manager/instances so the
// Integrations view reflects runtime.status live.
import { defineStore } from 'pinia'
import { manager } from '@/services/manager'

export const useManagerStore = defineStore('manager', {
  state: () => ({
    types: [],
    instances: [],

    lastError: null,
    loading: {
      types: false,
      instances: false
    },
    // per-instance action in flight (id -> action string) for button spinners
    busy: {},

    _pollTimer: null
  }),

  getters: {
    typeMap: (s) => Object.fromEntries(s.types.map((t) => [t.type, t])),
    typeFor: (s) => (type) => s.types.find((t) => t.type === type) || null,
    instanceCount: (s) => s.instances.length
  },

  actions: {
    async fetchTypes() {
      this.loading.types = true
      try {
        const data = await manager.types()
        this.types = data.types || []
        this.lastError = null
      } catch (e) {
        this.lastError = e.message
      } finally {
        this.loading.types = false
      }
    },

    async fetchInstances() {
      this.loading.instances = true
      try {
        const data = await manager.instances()
        this.instances = data.instances || []
        this.lastError = null
      } catch (e) {
        this.lastError = e.message
      } finally {
        this.loading.instances = false
      }
    },

    async createInstance(payload) {
      const inst = await manager.create(payload)
      await this.fetchInstances()
      return inst
    },

    async updateInstance(id, patch) {
      const inst = await manager.update(id, patch)
      await this.fetchInstances()
      return inst
    },

    async removeInstance(id) {
      this._setBusy(id, 'delete')
      try {
        await manager.remove(id)
        this.instances = this.instances.filter((i) => i.id !== id)
      } finally {
        this._clearBusy(id)
      }
    },

    // lifecycle — optimistic-ish: run the action then refetch for real status
    async start(id) {
      await this._lifecycle(id, 'start', () => manager.start(id))
    },
    async stop(id) {
      await this._lifecycle(id, 'stop', () => manager.stop(id))
    },
    async restart(id) {
      await this._lifecycle(id, 'restart', () => manager.restart(id))
    },

    // enable/disable toggle maps to start/stop AND persists the enabled flag so
    // the manager won't auto-restart a stopped instance on its own boot.
    async setEnabled(id, enabled) {
      this._setBusy(id, enabled ? 'start' : 'stop')
      try {
        await manager.update(id, { enabled })
        if (enabled) await manager.start(id)
        else await manager.stop(id)
        this.lastError = null
      } catch (e) {
        this.lastError = e.message
        throw e
      } finally {
        this._clearBusy(id)
        await this.fetchInstances()
      }
    },

    async fetchLogs(id) {
      const data = await manager.logs(id)
      return data.logs || []
    },

    async _lifecycle(id, label, fn) {
      this._setBusy(id, label)
      try {
        await fn()
        this.lastError = null
      } catch (e) {
        this.lastError = e.message
        throw e
      } finally {
        this._clearBusy(id)
        await this.fetchInstances()
      }
    },

    _setBusy(id, action) {
      this.busy = { ...this.busy, [id]: action }
    },
    _clearBusy(id) {
      const next = { ...this.busy }
      delete next[id]
      this.busy = next
    },

    startPolling(ms = 3000) {
      this.stopPolling()
      this._pollTimer = setInterval(() => {
        this.fetchInstances()
      }, ms)
    },
    stopPolling() {
      if (this._pollTimer) {
        clearInterval(this._pollTimer)
        this._pollTimer = null
      }
    }
  }
})
