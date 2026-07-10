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

restart_services(){
  pkill -f 'connectors/runtime/run-instance.js' 2>/dev/null || true   # drop stale connector children
  sleep 2
  pm2 restart asmltr-core asmltr-insights-collector asmltr-connector-manager >/dev/null 2>&1
}
reinstall(){ for d in core connectors insights/collector cli; do (cd "$REPO/$d" && npm install) >>"$LOG" 2>&1; done; }
# Critical services expose /health (core 3023, connector-manager 3024). Both must come back.
health_ok(){
  sleep 12
  curl -sf -o /dev/null --max-time 5 127.0.0.1:3023/health || return 1
  curl -sf -o /dev/null --max-time 5 127.0.0.1:3024/health || return 1
  return 0
}

log "restart after update → $(git -C "$REPO" rev-parse --short HEAD 2>/dev/null)"
restart_services
if health_ok; then log "health OK — update complete"; exit 0; fi

log "HEALTH CHECK FAILED after update — rolling back to ${ROLLBACK_SHA:-<none>}"
if [ -z "$ROLLBACK_SHA" ]; then log "no rollback sha — leaving as-is for manual intervention"; exit 3; fi
git -C "$REPO" reset --hard "$ROLLBACK_SHA" >>"$LOG" 2>&1
reinstall
restart_services
if health_ok; then log "ROLLED BACK to $ROLLBACK_SHA — services healthy"; exit 2; fi
log "ROLLBACK ALSO UNHEALTHY — manual intervention required"; exit 3
