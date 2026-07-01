// Pinia store for the trust framework (the "Access" control plane). Read/write:
// it manages principals (users), their cross-channel identifiers, roles, and
// capability grants. Unlike the manager store there is no runtime to poll —
// trust state only changes on explicit edits, so we refetch after mutations.
import { defineStore } from 'pinia'
import { trust } from '@/services/trust'
import { useManagerStore } from '@/stores/manager'

// Generic identifier surfaces that always make sense even when no connector
// type advertises identifierFormats for them.
const GENERIC_SURFACES = [
  { surface: 'apikey', label: 'API key', placeholder: 'sk-...', pattern: '' },
  { surface: 'mcp', label: 'MCP client id', placeholder: 'client-id', pattern: '' }
]

export const useTrustStore = defineStore('trust', {
  state: () => ({
    principals: [],
    roles: [],

    lastError: null,
    loading: {
      principals: false,
      roles: false
    },
    // per-principal mutation in flight (id -> action string) for spinners
    busy: {},

    // last resolve() result for the preview panel
    resolveResult: null,
    resolveError: null,
    resolving: false
  }),

  getters: {
    principalCount: (s) => s.principals.length,
    activePrincipalCount: (s) => s.principals.filter((p) => !p.revoked).length,
    roleCount: (s) => s.roles.length,

    roleMap: (s) => Object.fromEntries(s.roles.map((r) => [r.id, r])),
    roleName: (s) => (id) => {
      const r = s.roles.find((x) => x.id === id)
      return r ? r.name || r.id : id
    },

    // Identifier "surface" options for the picker: aggregate identifierFormats
    // across all registered connector types (manager store), de-duped by
    // surface, then always append the generic surfaces. Each entry:
    //   { surface, label, placeholder, pattern }
    identifierSurfaces() {
      const mgr = useManagerStore()
      const bySurface = new Map()
      for (const t of mgr.types || []) {
        for (const f of t.identifierFormats || []) {
          if (!f || !f.surface) continue
          if (!bySurface.has(f.surface)) {
            bySurface.set(f.surface, {
              surface: f.surface,
              label: f.label || f.surface,
              placeholder: f.placeholder || '',
              pattern: f.pattern || ''
            })
          }
        }
      }
      for (const g of GENERIC_SURFACES) {
        if (!bySurface.has(g.surface)) bySurface.set(g.surface, { ...g })
      }
      return Array.from(bySurface.values())
    },

    surfaceFormat: (s) => (surface) =>
      s.identifierSurfaces.find((f) => f.surface === surface) || null
  },

  actions: {
    async fetchPrincipals() {
      this.loading.principals = true
      try {
        const data = await trust.principals()
        this.principals = data.principals || []
        this.lastError = null
      } catch (e) {
        this.lastError = e.message
      } finally {
        this.loading.principals = false
      }
    },

    async fetchRoles() {
      this.loading.roles = true
      try {
        const data = await trust.roles()
        this.roles = data.roles || []
        this.lastError = null
      } catch (e) {
        this.lastError = e.message
      } finally {
        this.loading.roles = false
      }
    },

    // ---- principals ----
    async createPrincipal(payload) {
      const res = await trust.createPrincipal(payload)
      await this.fetchPrincipals()
      return res
    },
    async updatePrincipal(id, patch) {
      const res = await trust.updatePrincipal(id, patch)
      await this.fetchPrincipals()
      return res
    },
    async removePrincipal(id) {
      this._setBusy(id, 'delete')
      try {
        await trust.removePrincipal(id)
        this.principals = this.principals.filter((p) => p.id !== id)
        this.lastError = null
      } catch (e) {
        this.lastError = e.message
        throw e
      } finally {
        this._clearBusy(id)
      }
    },

    // ---- identifiers ----
    async addIdentifier(principalId, payload) {
      await trust.addIdentifier(principalId, payload)
      await this.fetchPrincipals()
    },
    async removeIdentifier(iid) {
      await trust.removeIdentifier(iid)
      await this.fetchPrincipals()
    },

    // ---- grants ----
    async addGrant(principalId, payload) {
      await trust.addGrant(principalId, payload)
      await this.fetchPrincipals()
    },
    async removeGrant(gid) {
      await trust.removeGrant(gid)
      await this.fetchPrincipals()
    },

    // ---- roles ----
    async saveRole(payload) {
      const res = await trust.saveRole(payload)
      await this.fetchRoles()
      return res
    },
    async removeRole(id) {
      await trust.removeRole(id)
      // refetch both: principals may reference this role
      await Promise.all([this.fetchRoles(), this.fetchPrincipals()])
    },

    // ---- resolve preview ----
    async resolve(payload) {
      this.resolving = true
      this.resolveError = null
      try {
        this.resolveResult = await trust.resolve(payload)
      } catch (e) {
        this.resolveResult = null
        this.resolveError = e.message
      } finally {
        this.resolving = false
      }
    },
    clearResolve() {
      this.resolveResult = null
      this.resolveError = null
    },

    _setBusy(id, action) {
      this.busy = { ...this.busy, [id]: action }
    },
    _clearBusy(id) {
      const next = { ...this.busy }
      delete next[id]
      this.busy = next
    }
  }
})
