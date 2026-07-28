# Deploying the web dashboard

The `insights/dashboard` is a Vue 3 observability GUI — live sessions, a cross-surface timeline, usage, and the trust **Access** page. It's an **optional** part of an install: the [`asmltr` CLI/TUI](../cli.md) already gives full local monitoring. Deploy the dashboard when you want a browser view.

It ships as a **static Vite build served by nginx**. That nginx also reverse-proxies the backend so tokens never reach the browser:

| Path | Proxies to | Purpose |
|---|---|---|
| `/api`, `/socket.io` | collector `:3017` | read telemetry (REST + websocket) |
| `/api/control` | collector `:3017` | control plane (kill / stop / send-keys) — uses the **stronger** control bearer |
| `/manager` | connector manager `:3024` | connector control plane (instances, config) |
| `/trust`, `/v2` | core `:3023` | trust/Access API and session inject/abort (takeover) |

Each service bearer is injected **server-side by nginx** (via `envsubst` at container start), and the authenticator-resolved user is forwarded as `X-Remote-User` for audit. Reference: [`insights/docker-compose.yml`](https://github.com/jarethmt/asmltr/blob/main/insights/docker-compose.yml) and `insights/dashboard/nginx.conf.template`.

!!! danger "Never expose it publicly without authentication in front"
    Because nginx proxies the **control plane** — the connector manager (`/manager`) and the core trust/Access API (`/trust`) — exposing the dashboard to the internet without an authenticator hands anyone your control plane. **If it is reachable publicly, it MUST sit behind an authenticator that restricts access to the specific user(s).** If you can't set that up, deploy local-only (over an SSH tunnel) instead.

## Build the SPA

Both deployment options need the static build:

```bash
(cd insights/dashboard && npm install && npm run build)
```

## Environment knobs

The compose file and nginx template read these (all optional, with sane defaults):

| Variable | Meaning | Default |
|---|---|---|
| `ASMLTR_INSIGHTS_HOST` | Traefik router hostname (the Host rule) | `insights.example.com` |
| `ASMLTR_NGINX_LISTEN` | nginx `listen` directive | `80` |
| `ASMLTR_UPSTREAM_HOST` | where nginx reaches the host services | `host.docker.internal` |
| `ASMLTR_INSIGHTS_TOKEN` | collector read bearer (must match the collector's token) | — |
| `ASMLTR_MANAGER_TOKEN` | connector-manager bearer (control plane) | — |
| `ASMLTR_INSIGHTS_CONTROL_TOKEN` | collector control-plane bearer (kill/stop/send-keys) | — |

Set the token variables only if you configured tokens on the collector/manager. The read and control tokens must match what the collector expects.

## Option A — local-only (no domain, no proxy)

Simplest and always available: serve the SPA bound to loopback and tunnel in.

```bash
ASMLTR_NGINX_LISTEN=127.0.0.1:8091 ASMLTR_UPSTREAM_HOST=127.0.0.1 \
  docker compose -f insights/docker-compose.yml up -d --build
```

Then from your workstation:

```bash
ssh -L 8091:127.0.0.1:8091 <server>
# open http://localhost:8091
```

## Option B — public, behind Traefik + Authelia

The shipped `insights/docker-compose.yml` already carries **Traefik docker-provider labels** and an `authelia@docker` forward-auth middleware. The general pattern:

1. **Reverse proxy + authenticator.** A reverse proxy (Traefik) terminates TLS and routes the hostname to the dashboard container; an authenticator (Authelia) sits in front as forward-auth. Any equivalent pairing works — Caddy/nginx for the proxy, oauth2-proxy / Authentik / Cloudflare Access / basic-auth for the authenticator — the requirement is only that **unauthenticated and other users are denied**.

2. **DNS.** Point your hostname (e.g. `insights.example.com`) at the server's public IP. If DNS is behind a proxying CDN, use DNS-only or an origin cert so the ACME/TLS challenge can complete.

3. **Set the hostname.** Set `ASMLTR_INSIGHTS_HOST` (or edit the router's `Host(...)` rule in the compose labels).

4. **Restrict to the user.** In Authelia, add its forward-auth middleware to the router and an `access_control` rule allowing only the user's `subject` (with `two_factor`), placed **above** any broad catch-all so it matches first, plus a deny for that domain otherwise. Validate (`authelia validate-config`) and restart. Other authenticators: use that tool's allow-list for the single user.

5. **TLS.** Let the proxy issue the cert (Traefik `certresolver`, Caddy auto-HTTPS, Certbot for nginx).

6. **Verify.** `dig +short <host>` resolves; `curl -sI https://<host>` **redirects to the login portal** (not the app) when unauthenticated; after logging in as the allowed user you reach the dashboard; any other/no user is denied.

### The network reachability gotcha

The host services bind `127.0.0.1`, so a reverse-proxy **container** cannot reach them directly. Two ways around it:

!!! tip "Recommended: host-network dashboard"
    When the host services are `127.0.0.1`-only, run the dashboard with `network_mode: host` and:

    - set `ASMLTR_NGINX_LISTEN` to a **private** interface the proxy can reach — e.g. the docker-bridge gateway `172.18.0.1:8091` — **not** the public NIC;
    - set `ASMLTR_UPSTREAM_HOST=127.0.0.1` so nginx reaches the host services on loopback;
    - point the proxy at `http://172.18.0.1:8091` via a file/dynamic route (don't rely on the docker-provider labels in this mode).

The alternative is `host.docker.internal`, which works on Docker Desktop, and on Linux only if the host services also listen on the bridge. In that case the shipped compose's `traefik-network` + labels model works as-is.

## Updating

When the dashboard is deployed, rebuild it after pulling a new asmltr version so the GUI picks up the update:

```bash
(cd insights/dashboard && npm install)
docker compose -f insights/docker-compose.yml up -d --build   # + any -f override / env vars you deployed with
```

If it's public, confirm afterward that an unauthenticated request still redirects to the login portal — that auth didn't regress.

### Let the updater rebuild the local-only dashboard

`scripts/update.js` rebuilds the dashboard on every `asmltr update`, but it only knows about the base `insights/docker-compose.yml` unless you tell it otherwise. That base file joins the external `traefik-network`; on a local-only box it fails with `network traefik-network declared as external, but could not be found`, so the rebuild fails each update & the GUI silently lags a version.

Save your local-only compose as `insights/docker-compose.<name>.yml` (e.g. `insights/docker-compose.local.yml`). `.gitignore` matches `insights/docker-compose.*.yml`, so `git reset --hard` during an update never touches it, & `scripts/update.js` scans `insights/` for a `docker-compose.*.yml` override & prefers it over the base Traefik compose. A minimal host-networked file:

```yaml
services:
  asmltr-insights-dashboard:
    build: ./dashboard
    container_name: asmltr-insights-dashboard
    network_mode: host
    environment:
      - NGINX_LISTEN=127.0.0.1:8091
      - ASMLTR_UPSTREAM_HOST=127.0.0.1
```

If you first ran the dashboard from a compose in another directory, run `docker rm -f asmltr-insights-dashboard` once so the new compose project can own the container name.
