#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# cannot-skip-gate-dashboard.sh — Verify every cannot-skip gate is wired
#
# Closes ENG-EXC-O3 (no single dashboard for cannot-skip gates).
#
# Background: scripts/changed-area-classifier.sh attaches a `cannotSkip`
# array to every diff classification. Each entry names a release-gate that
# CANNOT be skipped when the relevant area changes (e.g.
# tenant-auth-security, calendar-agenda-lifecycle, audit-trail-emission-
# and-scope). Today these gates are scattered across the classifier's
# inline rules; an operator has no single view of "which gates exist and
# what test maps to each".
#
# This script:
#   1. Synthetically invokes the classifier with a known-representative
#      input file per gate.
#   2. Asserts the gate name appears in the classifier's `cannotSkip`
#      list AND `vitest.globs` (or `xctest.classes`) for that synthetic
#      diff.
#   3. Emits markdown to stdout and a JSON evidence file under
#      engine/docs/release/cannot-skip-gate-evidence/<timestamp>.json.
#   4. Exits 1 on any gate that fails the wiring check.
#
# It does NOT execute the gate's tests — that's the regular CI's job.
# Its job is to prove every gate is connected to a test mapping. If a
# gate name is added to the classifier without an updated mapping, the
# dashboard fails loudly.
#
# Usage:
#   scripts/cannot-skip-gate-dashboard.sh                 # markdown
#   scripts/cannot-skip-gate-dashboard.sh --json          # JSON only
#   scripts/cannot-skip-gate-dashboard.sh --no-evidence   # skip writing evidence
#   scripts/cannot-skip-gate-dashboard.sh --quiet         # suppress markdown
#   scripts/cannot-skip-gate-dashboard.sh --base origin/main
#
# Exit codes:
#   0 — every gate fires correctly on its representative file
#   1 — at least one gate failed the wiring check
#   2 — usage / unexpected error
# ─────────────────────────────────────────────────────
set -euo pipefail

ENGINE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EVIDENCE_DIR="$ENGINE_ROOT/.local/release/cannot-skip-gate-evidence"
TS="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
OUTPUT_FORMAT="markdown"
WRITE_EVIDENCE=true
QUIET=false
BASE_REF=""

while [ $# -gt 0 ]; do
  case "$1" in
    --json)         OUTPUT_FORMAT="json"; shift;;
    --markdown)     OUTPUT_FORMAT="markdown"; shift;;
    --no-evidence)  WRITE_EVIDENCE=false; shift;;
    --quiet)        QUIET=true; shift;;
    --base)         BASE_REF="$2"; shift 2;;
    -h|--help)
      sed -n '2,40p' "$0" | sed 's/^# \?//'
      exit 0;;
    *) echo "Unknown arg: $1" >&2; exit 2;;
  esac
done

# Gate definitions: gate-name|representative-file|expected-source
# The "expected-source" is the canonical test family the gate routes to;
# the dashboard verifies the classifier emits it.
GATES=(
  "tenant-auth-security|src/api/routes/auth.ts|__tests__/api/auth-"
  "memory-retrieval-isolation|src/services/context-engine.ts|context"
  "prompt-injection-defense|prompts/secretary.md|__tests__/security/"
  "calendar-agenda-lifecycle|src/services/unified-calendar.ts|calendar"
  "provider-routing-fallback|src/services/provider-registry.ts|provider-"
  "migration-rollback-review|migrations/082_example.sql|MIGRATION"
  "irreversible-migration-manual-approval|migrations/200_content_radar_phase0_rollout_guards.sql|IRREVERSIBLE_MIGRATION"
  "exact-release-promotion-rehearsal|scripts/promote-exact-release.sh|release-runtime-safeguards,exact-promotion-operational-safety,release-exact-attestations,release-backup-runtime-artifact,rollback-versioned-runtime,pm2-sanitized-start,release-evidence-container"
  "hook-validation-on-feature-branch|.husky/pre-commit|HOOK"
  "ci-workflow-validation-on-PR|.github/workflows/ci.yml|CI"
  "test-config-mock-completeness-audit|vitest.config.ts|TEST_CONFIG"
  "attachment-tenant-isolation|src/api/routes/chat-message-attachments.ts|chat-attachments"
  "model-routing-cost-attribution|src/services/domain-provider-router.ts|domain-provider-router"
  "personalization-scope-isolation|src/services/cooking-preferences.ts|cooking-preferences"
  "content-agent-neutrality|src/agents/reaction-radar-agent.ts|content-agent-neutrality"
  "logger-redaction-pii-scan|src/utils/logger.ts|logger-"
  "scheduler-tenant-scope-and-failure|src/services/scheduler.ts|scheduler-"
  "notification-apns-delivery-and-tenant|src/services/notification-orchestrator.ts|notification-"
  "health-integration-tenant-isolation|src/services/garmin.ts|garmin-"
  "auth-rate-limit-and-lockout|src/api/middleware/rate-limit.ts|rate-limiter"
  "audit-trail-emission-and-scope|src/services/audit-trail.ts|audit-trail"
  "deploy-config-health-rehearsal|ecosystem.config.js|config-"
  "ios-navigation-responsiveness|Nexus Hub/Views/MainTabView.swift|NavigationPerformance"
  "ios-contract-decoder-resilience|Nexus Hub/Core/Services/TrainingService.swift|ContractDecoder"
  "apple-notifications-jws-verify|src/services/apple-jws-verifier.ts|apple-notifications-jws-verify"
  "training-routes-entitlement|src/api/routes/training.ts|training-routes-entitlement"
  "training-plan-create-e2e|src/services/training-plan-volume-enforcement.ts|training-plan-create-cycle"
  "content-engine-prompt-cleanliness|content-engine/services/creative/hook_generator.py|test_prompt_cleanliness"
  "voice-evolution-multi-tenant|src/agents/voice-evolution-agent.ts|voice-evolution-multi-tenant"
  "video-study-prompt-cleanliness|src/services/video-study.ts|video-study-prompt-cleanliness"
  "channel-learner-prompt-cleanliness|src/services/channel-learner.ts|channel-learner-prompt-cleanliness"
  "cost-guardrail-global-rest|src/services/cost-guardrail.ts|cost-guardrail-global-rest"
  "cache-coherence-registry|src/services/cache-coherence-registry.ts|cache-coherence-registry"
  "cached-route-handler|src/api/route-helpers/cached-route-handler.ts|cached-route-handler"
  "garmin-tenant-leak-and-apple-health-cascade|src/services/readiness-scorer.ts|garmin-tenant-leak-and-apple-health-cascade"
  "google-drive-tenant-leak|src/services/google-drive.ts|google-drive-tenant-leak"
  "registry-real-eval-quality-gates|src/services/chat/registry/index.ts|registry-real-eval-gates"
  "science-policy-version-check|src/services/coach-kernel/knowledge/entities/training-principles.json|coach-kernel-"
)

# Run the classifier once per gate and capture results into JSON.
RESULTS_JSON=""
PASS=0
FAIL=0
FAILED_GATES=()

for entry in "${GATES[@]}"; do
  IFS='|' read -r gate representative expected <<<"$entry"

  classifier_args=(--json --files "$representative")
  if [ -n "$BASE_REF" ]; then
    classifier_args+=(--base "$BASE_REF")
  fi

  output=$(bash "$ENGINE_ROOT/scripts/changed-area-classifier.sh" \
    "${classifier_args[@]}" 2>/dev/null) || {
    FAIL=$((FAIL+1))
    FAILED_GATES+=("$gate (classifier execution failed)")
    continue
  }

  # Use node for safe JSON parsing. Sentinels (MIGRATION /
  # IRREVERSIBLE_MIGRATION / HOOK / CI / TEST_CONFIG) are policy-only gates
  # with no specific test glob; we accept them if the cannotSkip name fires.
  # Other gates may provide a comma-separated set of required route tokens;
  # every token must resolve so a label-only gate cannot report success.
  result=$(node -e "
    const data = JSON.parse(process.argv[1]);
    const gate = process.argv[2];
    const expected = process.argv[3];
    const sentinels = new Set(['MIGRATION', 'IRREVERSIBLE_MIGRATION', 'HOOK', 'CI', 'TEST_CONFIG']);
    const cannotSkipHit = (data.cannotSkip || []).includes(gate);
    const allTestRoutes = [
      ...(data.vitest && data.vitest.globs ? data.vitest.globs : []),
      ...(data.pytest && data.pytest.globs ? data.pytest.globs : []),
      ...(data.xctest && data.xctest.classes ? data.xctest.classes : []),
    ];
    const expectedRoutes = expected.split(',').map((route) => route.trim()).filter(Boolean);
    const expectedHit = sentinels.has(expected)
      ? true
      : expectedRoutes.every((route) => allTestRoutes.some((candidate) => candidate.includes(route)));
    process.stdout.write(JSON.stringify({
      gate,
      representativeFile: process.argv[4],
      cannotSkipFires: cannotSkipHit,
      expectedTestRouteFires: expectedHit,
      expectedTestRoutes: expectedRoutes,
      pass: cannotSkipHit && expectedHit,
      vitestGlobs: data.vitest ? data.vitest.globs || [] : [],
      xctestClasses: data.xctest ? data.xctest.classes || [] : [],
    }));
  " "$output" "$gate" "$expected" "$representative")

  is_pass=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).pass ? 'true':'false')" "$result")
  if [ "$is_pass" = "true" ]; then
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1))
    FAILED_GATES+=("$gate (representative=$representative)")
  fi

  if [ -n "$RESULTS_JSON" ]; then
    RESULTS_JSON="$RESULTS_JSON,$result"
  else
    RESULTS_JSON="$result"
  fi
done

TOTAL=$((PASS + FAIL))
SUMMARY=$(node -e "
  const total = Number(process.argv[1]);
  const pass = Number(process.argv[2]);
  const fail = Number(process.argv[3]);
  const ts = process.argv[4];
  process.stdout.write(JSON.stringify({
    generatedAt: new Date().toISOString(),
    runIdentifier: ts,
    total,
    pass,
    fail,
    verdict: fail === 0 ? 'PASS' : 'FAIL',
    failedGates: process.argv.slice(5),
  }));
" "$TOTAL" "$PASS" "$FAIL" "$TS" "${FAILED_GATES[@]+"${FAILED_GATES[@]}"}")

PAYLOAD=$(node -e "
  const summary = JSON.parse(process.argv[1]);
  const results = process.argv[2] ? JSON.parse('[' + process.argv[2] + ']') : [];
  process.stdout.write(JSON.stringify({ summary, gates: results }, null, 2));
" "$SUMMARY" "$RESULTS_JSON")

# Optional evidence file
if [ "$WRITE_EVIDENCE" = true ]; then
  mkdir -p "$EVIDENCE_DIR"
  EVIDENCE_FILE="$EVIDENCE_DIR/cannot-skip-gate-${TS}.json"
  printf '%s\n' "$PAYLOAD" >"$EVIDENCE_FILE"
fi

# Output
if [ "$OUTPUT_FORMAT" = "json" ]; then
  printf '%s\n' "$PAYLOAD"
elif [ "$QUIET" = false ]; then
  echo "# Cannot-skip gate dashboard"
  echo ""
  echo "- Generated at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "- Total gates checked: $TOTAL"
  echo "- Pass: $PASS"
  echo "- Fail: $FAIL"
  if [ "$WRITE_EVIDENCE" = true ]; then
    # Print the evidence path relative to ENGINE_ROOT without depending on
    # GNU realpath (macOS realpath does not support --relative-to).
    rel_evidence="${EVIDENCE_FILE#"$ENGINE_ROOT/"}"
    echo "- Evidence: $rel_evidence"
  fi
  echo ""
  if [ "$FAIL" -eq 0 ]; then
    echo "**Verdict: PASS** — every cannot-skip gate fires on its representative file."
  else
    echo "**Verdict: FAIL** — $FAIL gate(s) did not fire correctly:"
    for g in "${FAILED_GATES[@]}"; do
      echo "- $g"
    done
  fi
  echo ""
  echo "## Per-gate detail"
  echo ""
  echo "| Gate | Representative file | cannotSkip fires | test route fires |"
  echo "|---|---|:---:|:---:|"
  node -e "
    const data = JSON.parse(process.argv[1]);
    for (const g of data.gates) {
      const skipFlag = g.cannotSkipFires ? '✓' : '✗';
      const routeFlag = g.expectedTestRouteFires ? '✓' : '✗';
      console.log('| \`' + g.gate + '\` | \`' + g.representativeFile + '\` | ' + skipFlag + ' | ' + routeFlag + ' |');
    }
  " "$PAYLOAD"
fi

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
