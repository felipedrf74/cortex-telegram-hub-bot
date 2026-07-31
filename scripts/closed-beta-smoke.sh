#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# closed-beta-smoke.sh — Aggregate smoke-test gate for closed beta.
#
# Closed-beta-readiness-hardening (2026-05-03).
#
# Wraps the individual smoke / scan scripts that together prove the
# closed-beta deployment is safe:
#
#   1. closed-beta-identity-scan.sh --strict
#        Exits non-zero if ANY founder/identity literal appears in
#        runtime code outside the allow-listed surfaces.
#   2. chat-tenant-security-smoke.js
#        Two-account chat tenant isolation smoke. Asserts user A
#        cannot see user B's identity, data, or memory through the
#        chat surface.
#   3. authenticated-api-smoke.sh
#        Token-driven smoke against /api/v1/* with app-shaped headers.
#        Confirms iOS-facing routes respond as the iOS client expects.
#   4. staging-smoke.sh
#        Existing 17/17 staging-process smoke. Confirms /health,
#        /api/snapshot, /api/cost-by-domain, etc. on the staging
#        process. Required precondition for exact promotion.
#   5. training-cross-skill-staging-smoke.sh --dry-run
#        Cross-skill training fixture smoke. Confirms training engine
#        + agenda orchestration + secretary calendar lifecycle stay
#        green together.
#        NON-EVIDENTIARY: this aggregator runs from a source checkout,
#        so the leg runs in --dry-run mode. Its staging runtime section
#        is blocked by design and its receipt is never staging proof.
#        Real staging proof comes from running that wrapper directly
#        against an installed release with NEXUS_RELEASE_BASE_DIR set.
#
# Failure semantics: any single smoke exiting non-zero fails the
# whole aggregator with the failed script's exit code. Aggregator
# does NOT short-circuit — it runs all five and reports a single
# summary at the end.
#
# Each leg's stdout/stderr is captured to .local/release/smoke-evidence/
# under closed-beta-smoke-<commit>-<utc-timestamp>/ so the operator
# has the per-leg log if any leg fails.
#
# Usage:
#   ./scripts/closed-beta-smoke.sh
#
# Pre-requisites the operator must arrange before running:
#   - Local backend running on 8200, staging running on 8201 (for
#     leg 4). Leg 5 is a source-checkout dry-run and needs neither.
#   - PORTAL_ADMIN_TOKEN env var for chat-tenant-security-smoke.js.
#   - IOS_INVITE_CODE env var (default LOCAL-BETA-2026).
#   - TOKEN env var (or --token-file) for authenticated-api-smoke.sh.
#   - npm run build is current (dist/ matches src/).
#
# The aggregator exits 0 only when every leg exits 0.
#
set -uo pipefail
# NB: pipefail is on but `set -e` is intentionally OFF — we want every
# leg to run even if an earlier leg fails, so the operator gets the
# full failure picture in a single run.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

UTC_NOW="$(date -u +%Y%m%dT%H%M%SZ)"
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
EVIDENCE_DIR=".local/release/smoke-evidence/closed-beta-smoke-${COMMIT}-${UTC_NOW}"
mkdir -p "$EVIDENCE_DIR"

# Optional skip flags so individual legs can be excluded when the
# operator knows a precondition isn't met (e.g. running locally
# without staging up). Default = run all.
SKIP_IDENTITY_SCAN="${SKIP_IDENTITY_SCAN:-0}"
SKIP_CHAT_TENANT="${SKIP_CHAT_TENANT:-0}"
SKIP_AUTH_API="${SKIP_AUTH_API:-0}"
SKIP_STAGING="${SKIP_STAGING:-0}"
SKIP_TRAINING_XSKILL="${SKIP_TRAINING_XSKILL:-0}"

echo "==========================================================="
echo "closed-beta-smoke.sh"
echo "Commit: ${COMMIT}"
echo "UTC:    ${UTC_NOW}"
echo "Evidence dir: ${EVIDENCE_DIR}"
echo "==========================================================="

declare -a LEG_NAMES=()
declare -a LEG_RESULTS=()
declare -a LEG_DURATIONS=()

run_leg() {
  local name="$1"
  local skip_flag="$2"
  shift 2
  local cmd=("$@")
  local log_file="${EVIDENCE_DIR}/${name}.log"

  echo
  echo "─── ${name} ─────────────────────────────────"

  if [ "$skip_flag" = "1" ]; then
    echo "SKIPPED (env flag set)"
    LEG_NAMES+=("$name")
    LEG_RESULTS+=("skipped")
    LEG_DURATIONS+=("0")
    return 0
  fi

  local start_ts
  start_ts=$(date +%s)
  set +e
  "${cmd[@]}" 2>&1 | tee "$log_file"
  local rc=${PIPESTATUS[0]}
  set -e 2>/dev/null || true
  local end_ts
  end_ts=$(date +%s)
  local duration=$((end_ts - start_ts))

  LEG_NAMES+=("$name")
  LEG_DURATIONS+=("$duration")
  if [ "$rc" -eq 0 ]; then
    LEG_RESULTS+=("pass")
    echo "✓ ${name} PASS (${duration}s)"
  else
    LEG_RESULTS+=("fail rc=${rc}")
    echo "✗ ${name} FAIL rc=${rc} (${duration}s) — see ${log_file}"
  fi
}

# Leg 1: identity scan (strict)
run_leg "01-closed-beta-identity-scan" "$SKIP_IDENTITY_SCAN" \
  ./scripts/closed-beta-identity-scan.sh --strict

# Leg 2: chat tenant security smoke
run_leg "02-chat-tenant-security-smoke" "$SKIP_CHAT_TENANT" \
  node ./scripts/chat-tenant-security-smoke.js

# Leg 3: authenticated API smoke
# Requires TOKEN env var or token file path. The script itself fails
# fast if neither is provided — surfaces as a leg failure.
run_leg "03-authenticated-api-smoke" "$SKIP_AUTH_API" \
  ./scripts/authenticated-api-smoke.sh

# Leg 4: staging smoke (the existing 17/17 gate)
run_leg "04-staging-smoke" "$SKIP_STAGING" \
  ./scripts/staging-smoke.sh

# Leg 5: cross-skill training fixtures (non-evidentiary dry-run).
# This aggregator runs from a source checkout, which has no verified
# .complete.json release marker, so the wrapper refuses staging proof
# (exit 3) unless --dry-run is passed. Exit 2 means the staging runtime
# section was blocked by design — expected here, not a leg failure.
training_cross_skill_fixture_dry_run() {
  ./scripts/training-cross-skill-staging-smoke.sh --dry-run
  local rc=$?
  if [ "$rc" -eq 2 ]; then
    echo "Cross-skill fixtures ran; staging runtime section blocked by design in dry-run (non-evidentiary)."
    return 0
  fi
  return "$rc"
}

run_leg "05-training-cross-skill-fixtures-dry-run" "$SKIP_TRAINING_XSKILL" \
  training_cross_skill_fixture_dry_run

# Summary
echo
echo "==========================================================="
echo "closed-beta-smoke summary (commit ${COMMIT}, ${UTC_NOW})"
echo "==========================================================="
total=${#LEG_NAMES[@]}
pass_count=0
fail_count=0
skip_count=0
for i in "${!LEG_NAMES[@]}"; do
  name="${LEG_NAMES[$i]}"
  result="${LEG_RESULTS[$i]}"
  duration="${LEG_DURATIONS[$i]}"
  printf "  %-40s %-12s %3ss\n" "$name" "$result" "$duration"
  case "$result" in
    pass) pass_count=$((pass_count + 1)) ;;
    skipped) skip_count=$((skip_count + 1)) ;;
    *) fail_count=$((fail_count + 1)) ;;
  esac
done
echo "-----------------------------------------------------------"
printf "  Total: %d  Pass: %d  Fail: %d  Skipped: %d\n" \
  "$total" "$pass_count" "$fail_count" "$skip_count"
echo "  Evidence: ${EVIDENCE_DIR}"
echo "==========================================================="

# Persist a one-line JSON summary so operators can grep evidence
# directories for status without parsing logs.
SUMMARY_FILE="${EVIDENCE_DIR}/summary.json"
cat > "$SUMMARY_FILE" <<EOF
{
  "commit": "${COMMIT}",
  "utc": "${UTC_NOW}",
  "total": ${total},
  "pass": ${pass_count},
  "fail": ${fail_count},
  "skipped": ${skip_count}
}
EOF

if [ "$fail_count" -gt 0 ]; then
  exit 1
fi
exit 0
