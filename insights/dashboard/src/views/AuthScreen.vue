<script setup>
// The login / first-run screen (roadmap P1 phase B). Shown by App.vue when auth is enabled and there's
// no valid session. First run (no account yet) → create the initial account; otherwise → sign in. On
// success we reload so the whole app boots cleanly with the session cookie in place.
import { ref, computed } from 'vue'
import { authApi } from '@/services/api'
import BrandLogo from '@/components/BrandLogo.vue'

const props = defineProps({ configured: { type: Boolean, default: true }, agentName: { type: String, default: 'asmltr' } })

const username = ref('')
const password = ref('')
const confirm = ref('')
const totp = ref('')
const totpRequired = ref(false)
const busy = ref(false)
const error = ref('')
const isSetup = computed(() => !props.configured)

async function submit() {
  error.value = ''
  if (!username.value || !password.value) { error.value = 'Enter a username and password.'; return }
  if (isSetup.value) {
    if (password.value.length < 8) { error.value = 'Password must be at least 8 characters.'; return }
    if (password.value !== confirm.value) { error.value = 'Passwords do not match.'; return }
  }
  busy.value = true
  try {
    if (isSetup.value) await authApi.setup(username.value, password.value)
    const r = await authApi.login(username.value, password.value, totp.value || undefined)
    if (r.ok) { window.location.reload(); return }
    if (r.totp_required) { totpRequired.value = true; error.value = totp.value ? 'Invalid code — try again.' : ''; busy.value = false; return }
    error.value = r.error || 'Authentication failed.'
    busy.value = false
  } catch (e) {
    error.value = e.message || 'Authentication failed.'
    busy.value = false
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center px-4">
    <div class="glass w-full max-w-sm p-7">
      <div class="mb-6 flex flex-col items-center gap-3 text-center">
        <BrandLogo class="h-12 w-12" />
        <div>
          <div class="text-lg font-bold tracking-tight"><span class="gradient-text">{{ agentName }}</span></div>
          <div class="text-[11px] text-slate-400">asmltr control plane</div>
        </div>
      </div>

      <h1 class="mb-1 text-center text-sm font-semibold text-slate-200">
        {{ isSetup ? 'Create the first account' : 'Sign in' }}
      </h1>
      <p class="mb-5 text-center text-[12px] text-slate-500">
        {{ isSetup ? 'No account exists yet — set the initial admin credentials.' : 'Enter your credentials to continue.' }}
      </p>

      <form class="flex flex-col gap-3" @submit.prevent="submit">
        <template v-if="!totpRequired">
          <input v-model="username" type="text" autocomplete="username" placeholder="Username" class="field" />
          <input v-model="password" type="password" :autocomplete="isSetup ? 'new-password' : 'current-password'" placeholder="Password" class="field" />
          <input v-if="isSetup" v-model="confirm" type="password" autocomplete="new-password" placeholder="Confirm password" class="field" />
        </template>
        <template v-else>
          <p class="text-center text-[12px] text-slate-400">Enter the 6-digit code from your authenticator (or a recovery code).</p>
          <input v-model="totp" type="text" inputmode="text" autocomplete="one-time-code" placeholder="2FA code" class="field text-center tracking-widest" autofocus />
        </template>

        <p v-if="error" class="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{{ error }}</p>

        <button type="submit" :disabled="busy"
          class="mt-1 rounded-xl bg-brand-gradient px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-brand-violet/30 transition-opacity hover:opacity-90 disabled:opacity-40">
          {{ busy ? 'Please wait…' : totpRequired ? 'Verify & sign in' : (isSetup ? 'Create account & sign in' : 'Sign in') }}
        </button>
      </form>
    </div>
  </div>
</template>

<style scoped>
.field {
  @apply w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-slate-100 outline-none transition-colors;
  @apply placeholder:text-slate-600 focus:border-brand-violet/60 focus:bg-white/[0.06];
}
</style>
