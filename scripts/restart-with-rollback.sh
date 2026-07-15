#!/bin/bash
# asmltr self-update — restart the services, health-check, and AUTO-ROLL-BACK on failure.
# Usage: restart-with-rollback.sh <rollback-sha>
# Called by the update session AFTER it has pulled + reinstalled deps. Runs synchronously in the
# update-session process (which is separate from the services it restarts, so it survives to verify).
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROLLBACK_SHA="${1:-}"
LOG="${ASMLTR_UPDATE_LOG:-$HOME/.asmltr/update.log}"
mkdir -p "$(dirname "$LOG")"
log(){ echo "[$(date '+%F %T')] $*" | tee -a "$LOG" >&2; }

target_sha(){ git -C "$REPO" rev-parse --short HEAD 2>/dev/null; }

restart_services(){
  # The connector manager reaps its own children on stop (SIGINT/SIGTERM), so restarting it
  # cleanly cycles every connector onto the new code — NO pkill needed. The old `pkill -f
  # run-instance.js` was both unnecessary here and a footgun in the docs (it matched the shell
  # running the update and killed it before pm2 restart ran — see issue #8).
  pm2 restart asmltr-core asmltr-insights-collector asmltr-connector-manager >/dev/null 2>&1
}
# Root workspace install (core/connectors/cli/insights-collector are npm workspaces of the root
# package.json). One install covers them all; the dashboard is built separately in Docker. Prefer
# `npm ci` from the committed lockfile (exact-match, deterministic); fall back to `npm install`.
reinstall(){
  if [ -f "$REPO/package-lock.json" ]; then (cd "$REPO" && npm ci --no-audit --no-fund) >>"$LOG" 2>&1 && return 0; fi
  (cd "$REPO" && npm install --no-audit --no-fund) >>"$LOG" 2>&1;
}

# Verify each service is (a) up AND (b) actually running the expected code sha. /health alone is
# not enough: a restart that silently never happened still returns 200 from the OLD process. We
# compare each service's /version sha against the on-disk HEAD to prove the restart truly landed.
verify_ok(){
  local want="$1" svc host got
  sleep 12
  for hp in "core:3023" "manager:3024" "collector:3017"; do
    svc="${hp%%:*}"; host="${hp##*:}"
    curl -sf -o /dev/null --max-time 5 "127.0.0.1:$host/health" || { log "verify: $svc /health not responding"; return 1; }
    [ -z "$want" ] && continue                       # no target sha available → health-only
    got="$(curl -sf --max-time 5 "127.0.0.1:$host/version" | sed -n 's/.*"sha":"\([^"]*\)".*/\1/p')"
    [ "$got" = "unknown" ] && { log "verify: $svc sha unknown (no git) — health-only"; continue; }
    if [ "$got" != "$want" ]; then log "verify: $svc running sha '$got', expected '$want' — restart did NOT land"; return 1; fi
  done
  return 0
}

log "restart after update → $(target_sha)"
restart_services
if verify_ok "$(target_sha)"; then log "verify OK — update complete (sha $(target_sha))"; exit 0; fi

log "VERIFY FAILED after update — rolling back to ${ROLLBACK_SHA:-<none>}"
if [ -z "$ROLLBACK_SHA" ]; then log "no rollback sha — leaving as-is for manual intervention"; exit 3; fi
git -C "$REPO" reset --hard "$ROLLBACK_SHA" >>"$LOG" 2>&1
reinstall
restart_services
if verify_ok "$(target_sha)"; then log "ROLLED BACK to $ROLLBACK_SHA — services healthy on $(target_sha)"; exit 2; fi
log "ROLLBACK ALSO UNHEALTHY — manual intervention required"; exit 3
