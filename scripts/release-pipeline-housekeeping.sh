#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# release-pipeline-housekeeping.sh — Periodic cleanup tasks
#
# release-pipeline-risk-based-optimization (2026-05-03) — Round 4.
# engineering-excellence enrichment (2026-05-04, ENG-EXC-O3 + O8) — Round 5.
#
# Designed to be run weekly via cron, GitHub Actions schedule, or
# `gh workflow run`. Combines the routine maintenance steps that
# the operator otherwise has to remember:
#
#   1. Prune smoke-evidence files older than 60 days
#   2. Refresh release-identity.{json,md} from the current tree
#   3. Refresh workspace-docs mirror (engine/docs/_workspace-mirror)
#   4. Cannot-skip gate dashboard (verifies every gate is wired)
#   5. Print docs:audit baseline (advisory)
#
# Usage:
#   scripts/release-pipeline-housekeeping.sh                # dry-run (default)
#   scripts/release-pipeline-housekeeping.sh --apply        # actually mutate
#   scripts/release-pipeline-housekeeping.sh --quiet        # minimal stdout
#
# Exit code:
#   0  housekeeping ran cleanly (nothing to do or applied successfully)
#   1  any sub-step errored
# ─────────────────────────────────────────────────────
set -euo pipefail

LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPLY=false
QUIET=false

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    --quiet) QUIET=true ;;
    -h|--help)
      sed -n '2,25p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
  esac
done

log() { [ "$QUIET" = false ] && echo "$@"; }

OVERALL_RC=0

log "═══════════════════════════════════════════════"
log "  🧹 Release-pipeline housekeeping"
log "═══════════════════════════════════════════════"
log "  apply: $APPLY"
log "  date:  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
log ""

# ── 1. Smoke-evidence prune ────────────────────────────
log "1. Smoke-evidence prune"
if [ -x "$LOCAL_DIR/scripts/smoke-evidence-prune.sh" ]; then
  if [ "$APPLY" = true ]; then
    "$LOCAL_DIR/scripts/smoke-evidence-prune.sh" --apply || OVERALL_RC=1
  else
    "$LOCAL_DIR/scripts/smoke-evidence-prune.sh" || OVERALL_RC=1
  fi
else
  log "   ⚠️ scripts/smoke-evidence-prune.sh not found — skipping"
fi
log ""

# ── 2. Refresh release-identity ───────────────────────
log "2. Refresh release-identity.{json,md}"
if [ -x "$LOCAL_DIR/scripts/release-identity.sh" ]; then
  if [ "$APPLY" = true ]; then
    "$LOCAL_DIR/scripts/release-identity.sh" --persist --quiet \
      && log "   ✅ persisted" \
      || { log "   ❌ persist failed"; OVERALL_RC=1; }
  else
    log "   (dry-run) would re-persist docs/release/release-identity.{json,md}"
  fi
else
  log "   ⚠️ scripts/release-identity.sh not found — skipping"
fi
log ""

# ── 3. Workspace-docs mirror refresh ───────────────────
log "3. Workspace-docs mirror refresh (ENG-EXC-O8)"
if [ -x "$LOCAL_DIR/scripts/workspace-docs-mirror.sh" ]; then
  if [ "$APPLY" = true ]; then
    "$LOCAL_DIR/scripts/workspace-docs-mirror.sh" \
      && log "   ✅ mirror refreshed" \
      || { log "   ❌ mirror refresh failed"; OVERALL_RC=1; }
  else
    "$LOCAL_DIR/scripts/workspace-docs-mirror.sh" --check >/dev/null 2>&1 \
      && log "   (dry-run) workspace-mirror in sync" \
      || log "   (dry-run) workspace-mirror has DRIFT — apply to refresh"
  fi
else
  log "   ⚠️ scripts/workspace-docs-mirror.sh not found — skipping"
fi
log ""

# ── 4. Cannot-skip gate dashboard ─────────────────────
log "4. Cannot-skip gate dashboard (ENG-EXC-O3)"
if [ -x "$LOCAL_DIR/scripts/cannot-skip-gate-dashboard.sh" ]; then
  # Always emit JSON evidence (operator-recoverable). Dashboard verifies
  # every cannot-skip gate fires on its representative file.
  if "$LOCAL_DIR/scripts/cannot-skip-gate-dashboard.sh" --quiet >/dev/null 2>&1; then
    log "   ✅ all cannot-skip gates wired"
  else
    log "   ❌ cannot-skip gate wiring failed — re-run for detail"
    OVERALL_RC=1
  fi
else
  log "   ⚠️ scripts/cannot-skip-gate-dashboard.sh not found — skipping"
fi
log ""

# ── 5. docs:audit advisory ─────────────────────────────
log "5. docs:audit (advisory; informational only)"
if [ -f "$LOCAL_DIR/scripts/audit-docs.mjs" ]; then
  AUDIT_TOTAL=$(NODE_NO_WARNINGS=1 node "$LOCAL_DIR/scripts/audit-docs.mjs" --json 2>/dev/null \
    | NODE_NO_WARNINGS=1 node -e "let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>{try{process.stdout.write(String(JSON.parse(b).summary.issueCount))}catch(_){process.stdout.write('?')}})" \
    || echo "?")
  log "   docs:audit total: $AUDIT_TOTAL"
else
  log "   ⚠️ scripts/audit-docs.mjs not found — skipping"
fi
log ""

if [ "$APPLY" = false ]; then
  log "Re-run with --apply to actually prune + persist."
fi
log "═══════════════════════════════════════════════"
log "  🧹 Housekeeping complete (exit $OVERALL_RC)"
log "═══════════════════════════════════════════════"
exit "$OVERALL_RC"
