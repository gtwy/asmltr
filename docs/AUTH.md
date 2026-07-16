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

**How enforcement works (phase B).** The dashboard's nginx runs an `auth_request` subrequest to the core's
`GET /v2/auth/verify` on every proxied backend call (`/api`, `/v2`, `/manager`, `/trust`, `/socket.io`).
`/v2/auth/*` (login/setup/status) and the SPA shell stay public so you can reach the login screen.
Verify returns **200** for a valid session cookie (and sets `Remote-User`), **401** otherwise → the SPA
shows its login/first-run screen. **Break-glass:** when `ASMLTR_AUTH` is off, verify returns 200
unconditionally — so `ASMLTR_AUTH=off` + a core restart instantly unlocks a lockout. Connectors and the
CLI talk to the core **directly** (not through nginx), so they are never gated.

## Provider modes (gating other services)

- **Forward-auth** (Authelia parity) — the reverse proxy calls asmltr's `/v2/auth/verify` on each request;
  asmltr returns `200 + identity headers` (`Remote-User`, `Remote-Groups`, …) when the session is valid and
  authorized for the resource, or `401 → redirect` to asmltr's login portal. Per-resource access rules.
  Works with any Traefik/nginx/Caddy, no per-app integration. **This alone delivers "hide any service
  behind asmltr auth."**
- **OIDC provider** — full OAuth2/OIDC issuance (authorization-code + PKCE, JWKS, token + userinfo
  endpoints, a client registry, consent) for apps that speak OIDC natively.

## The vault and web login are separate (by design)

Web login does **not** unlock the [TRUST vault](security/trust-vault.md) — deliberately. Coupling them
would make the web portal a potential brute-force surface for the vault key, and the two concerns are
cleanly independent. The vault is unlocked on its own (`asmltr vault unseal`, or the Vault plane's unseal
form), and stays that way across restarts if you configure auto-unseal.

Instead, a locked vault is made **loud** so nothing silently fails:

- **Dashboard** — a global amber banner appears on every page when the vault is configured but sealed or
  unreachable, linking straight to the unlock form.
- **Sessions** — the core injects a `VAULT LOCKED` note into the system prompt, so the agent knows that
  credential-backed operations will fail and tells the user to unlock it rather than guessing or
  hardcoding a secret.

## Build phases

Dependency-ordered; each is verified on its own before the next. The security-critical bits (vault
linkage, OIDC provider) come *after* the session gate is solid.

| Phase | Scope | State |
|-------|-------|-------|
| **A — Session gate** | account store + scrypt password + signed-cookie sessions + login/logout/session endpoints + rate-limit; **enforcement flag off by default** | ✅ shipped |
| **B — Enforcement + login UI** | nginx `auth_request` → `/v2/auth/verify` gates browser traffic; GUI login + first-run screen; then **replace Authelia** on this box | ✅ shipped (Authelia cutover pending first-run) |
| **C — 2FA** | TOTP enrollment/verify + one-time recovery codes (✅); WebAuthn passkey (pending) | ✅ TOTP shipped |
| **D — OIDC client** | external-IdP login (GitHub + Google), link-based, off unless configured | ✅ shipped |
| **E — Forward-auth provider** | `/v2/auth/verify` + cookie-domain sessions + optional allowlist + identity header (Authelia parity for other services) | ✅ shipped |
| **F — OIDC provider** | OAuth2/OIDC token issuance (panva `oidc-provider`) + client registry + session-reuse login/consent | ✅ shipped |
| **G — Vault: separate unlock + loud warnings** | web login does **not** unlock the vault; unlock stays separate, and a locked vault warns on the dashboard + in every session | ✅ shipped |

## Two-factor (phase C)

TOTP (RFC 6238) is built in — enroll under **Settings → Security** (scan the QR or enter the key, confirm
a code) and you get **10 one-time recovery codes**. Login then requires a 6-digit code (or a recovery
code) as a second step. Endpoints: `POST /v2/auth/totp/{setup,enable,disable}` (session-gated); the login
returns `{ totp_required: true }` until a valid second factor is supplied. WebAuthn passkeys are a planned
follow-on.

## External login (phase D — OIDC client)

Sign into asmltr with **GitHub** or **Google**, mapped to a local account. It's **off unless configured** —
set a provider's `ASMLTR_OIDC_<PROVIDER>_ID` + `_SECRET` (register an OAuth app; redirect URI =
`<ASMLTR_AUTH_ORIGIN>/v2/auth/external/<provider>/callback`) and its button appears on the login screen.

**Link-based + default-deny.** External sign-in only works for an identity a user has **linked** to their
account first (Settings → Security → *Connected accounts* → Connect, while logged in). An unlinked
GitHub/Google identity is rejected — you can't create or take over an account by signing in with a random
external identity. Disconnect any time.

## Gating other services (phase E — forward-auth)

Any service behind a reverse proxy can be put behind asmltr's login using **forward-auth** to
`/v2/auth/verify` — the same mechanism the dashboard uses. Set a **parent-domain cookie** so one login
covers all subdomains:

```bash
ASMLTR_AUTH_COOKIE_DOMAIN=.example.com     # session cookie spans *.example.com
ASMLTR_AUTH_ALLOW=alice,bob                # optional: only these users pass (empty = any signed-in user)
```

Traefik middleware (points at asmltr's verify; forwards the resolved user):

```yaml
http:
  middlewares:
    asmltr-auth:
      forwardAuth:
        address: "https://asmltr.example.com/v2/auth/verify"
        authResponseHeaders:
          - Remote-User
```

Attach `asmltr-auth@file` to any router. `verify` returns **200 + `Remote-User`** for a valid session,
**401** otherwise (the proxy can redirect to asmltr's login), or **403** if an allowlist excludes the user.
When `ASMLTR_AUTH` is off it returns 200 (break-glass). The full OAuth2/OIDC **provider** (phase F) is for
apps that speak OIDC natively rather than trusting proxy headers.

## OIDC provider (phase F)

`ASMLTR_OIDC=on` mounts a standards **OAuth2/OIDC provider** (panva `oidc-provider`) at `<origin>/oidc` —
so apps can SSO against asmltr. Discovery is at `/oidc/.well-known/openid-configuration`; the signing
keys (`/oidc/jwks`) and cookie keys are generated + persisted under `~/.asmltr/oidc`.

- **Accounts** map to asmltr's local users (`findAccount`); **login + consent reuse the asmltr session** —
  an unauthenticated authorize request bounces through the login screen (`/?next=…`) and, once you're
  signed in, auto-completes (first-party clients are trusted, so consent is automatic).
- **Clients** are registered under **Settings → Security → OIDC provider** (or `POST /v2/oidc/clients`):
  give a name + redirect URI(s); the `client_secret` is shown once. Stored in `~/.asmltr/oidc/clients.json`;
  **new clients take effect on the next core restart**. Confidential (`client_secret_basic`) and public
  (PKCE) clients are both supported.
- Standard authorization-code + refresh-token flow. Point any OIDC RP at the issuer above.

!!! note "v1 scope"
    The token/grant store is in-memory (grants + sessions reset on a core restart; users simply re-auth).
    A persistent adapter is a natural follow-on for high-availability installs.

## Security principles (non-negotiable)

- The web login credential is **never** the vault passphrase (envelope-wrap; no brute-force oracle).
- Rate-limit + lockout on every credential-checking endpoint; constant-time comparisons.
- `__Host-`/`Secure`/`httpOnly`/`SameSite` cookies; CSRF tokens on state changes.
- Enforcement is **opt-in and rolled out deliberately** — never flip auth on under a live system blind.
- Secrets (`ASMLTR_AUTH_SECRET`, hashes, wrapped keys) live in the gitignored config / vault, never the repo.
