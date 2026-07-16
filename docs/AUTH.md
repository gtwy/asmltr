# Auth & identity provider (roadmap P1)

asmltr becomes the **identity plane** for an agent's whole surface — not just a login for its own
dashboard, but a reusable auth provider other services hide behind. The same engine points two ways:

- **Inward** — gate asmltr's own GUI + API (replacing the external Authelia edge gate).
- **Outward** — gate *other* services, via **forward-auth** (Authelia-style header/redirect) and a full
  **OIDC provider** (standards token issuance).

It also unlocks the [TRUST vault](security/trust-vault.md): logging in unwraps an envelope-wrapped vault
key, so a running install can use credentials — **without the login credential ever being the vault
passphrase** (no brute-force oracle from the web portal).

## Identities & factors

- **Local accounts** — password (scrypt, constant-time verify), **TOTP**, **WebAuthn passkey**, one-time
  recovery codes. First-run sets the initial admin account.
- **External IdP login (OIDC client)** — sign in to asmltr through an external OIDC provider
  (Google/GitHub/an existing Authelia) as an alternative/addition to a local password.
- Accounts map to the existing trust/[Cast](CAST.md) identities where they overlap (the principal is the
  same whether they arrive by Discord, the GUI, or a gated service).

## Sessions (the foundation)

Stateless, **HMAC-signed session tokens** (`{sub, iat, exp}` signed with `ASMLTR_AUTH_SECRET`) carried in
a **`__Host-` httpOnly, `Secure`, `SameSite=Lax` cookie**. No server-side session store to lose on
restart; revocation via a token version + short TTL + refresh. Login is **rate-limited with lockout**;
all secret comparisons are constant-time; state-changing requests are CSRF-protected.

**Additive + flag-gated.** The whole layer is off unless `ASMLTR_AUTH=on`, so adopting it never breaks an
install that fronts asmltr with its own reverse-proxy auth. Enforcement is rolled out deliberately, never
flipped on under a live system by surprise.

## Provider modes (gating other services)

- **Forward-auth** (Authelia parity) — the reverse proxy calls asmltr's `/v2/auth/verify` on each request;
  asmltr returns `200 + identity headers` (`Remote-User`, `Remote-Groups`, …) when the session is valid and
  authorized for the resource, or `401 → redirect` to asmltr's login portal. Per-resource access rules.
  Works with any Traefik/nginx/Caddy, no per-app integration. **This alone delivers "hide any service
  behind asmltr auth."**
- **OIDC provider** — full OAuth2/OIDC issuance (authorization-code + PKCE, JWKS, token + userinfo
  endpoints, a client registry, consent) for apps that speak OIDC natively.

## The vault linkage (no brute-force oracle)

The vault master passphrase is **never** the web login credential. Instead the vault key is stored
**envelope-wrapped** under a key derived from the login secret: `E(vault_key, K_login)`, `K_login =
KDF(password/second-factor)`. A successful, rate-limited, 2FA'd login unwraps it in memory; the web portal
can't be used to brute-force the vault key (wrong logins are throttled + locked, and never touch the raw
key). A **paranoid/unlinked mode** keeps vault unseal fully separate from web login for the most sensitive
installs.

## Build phases

Dependency-ordered; each is verified on its own before the next. The security-critical bits (vault
linkage, OIDC provider) come *after* the session gate is solid.

| Phase | Scope | State |
|-------|-------|-------|
| **A — Session gate** | account store + scrypt password + signed-cookie sessions + login/logout/session endpoints + rate-limit; **enforcement flag off by default** | foundation |
| **B — Enforcement + login UI** | `requireAuth` on the core/collector, a GUI login portal + first-run setup, then **replace Authelia** on this box | |
| **C — 2FA** | TOTP enrollment/verify, WebAuthn passkey register/login, recovery codes | |
| **D — OIDC client** | external-IdP login option | |
| **E — Forward-auth provider** | `/v2/auth/verify` + per-resource rules + identity headers (Authelia parity for other services) | |
| **F — OIDC provider** | OAuth2/OIDC token issuance + client registry + consent | |
| **G — Vault linkage** | envelope-wrapped vault key unwrapped on login; paranoid/unlinked mode | |

## Security principles (non-negotiable)

- The web login credential is **never** the vault passphrase (envelope-wrap; no brute-force oracle).
- Rate-limit + lockout on every credential-checking endpoint; constant-time comparisons.
- `__Host-`/`Secure`/`httpOnly`/`SameSite` cookies; CSRF tokens on state changes.
- Enforcement is **opt-in and rolled out deliberately** — never flip auth on under a live system blind.
- Secrets (`ASMLTR_AUTH_SECRET`, hashes, wrapped keys) live in the gitignored config / vault, never the repo.
