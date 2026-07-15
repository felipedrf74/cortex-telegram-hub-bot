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
#   2. Cannot-skip gate dashboard (verifies every gate is wired)
#   3. Enforce documentation policy
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

# ── 2. Cannot-skip gate dashboard ─────────────────────
log "2. Cannot-skip gate dashboard (ENG-EXC-O3)"
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

# ── 3. docs:audit enforcement ──────────────────────────
log "3. docs:audit (enforcing)"
if [ -f "$LOCAL_DIR/scripts/audit-docs.mjs" ]; then
  AUDIT_TOTAL=$(NODE_NO_WARNINGS=1 node "$LOCAL_DIR/scripts/audit-docs.mjs" --strict --json 2>/dev/null \
    | NODE_NO_WARNINGS=1 node -e "let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>{try{process.stdout.write(String(JSON.parse(b).summary.issueCount))}catch(_){process.stdout.write('?')}})" \
    || { OVERALL_RC=1; echo "?"; })
  log "   docs:audit total: $AUDIT_TOTAL"
else
  log "   ⚠️ scripts/audit-docs.mjs not found — skipping"
fi
log ""

if [ "$APPLY" = false ]; then log "Re-run with --apply to prune local evidence."; fi
log "═══════════════════════════════════════════════"
log "  🧹 Housekeeping complete (exit $OVERALL_RC)"
log "═══════════════════════════════════════════════"
exit "$OVERALL_RC"
