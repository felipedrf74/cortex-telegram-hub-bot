#!/usr/bin/env bash
# End-to-end Content Creation validation entrypoint.
#
# This is a local-only operator harness. It builds/boots the latest local
# backend + content-engine containers from the current checkout, records runtime
# identity, runs backend Content checks, optionally runs the iOS Content Studio
# simulator suites, and emits Felipe's manual script-quality checklist.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RUN_ID="${CONTENT_E2E_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
EVIDENCE_DIR="${CONTENT_E2E_EVIDENCE_DIR:-$ROOT/.local/content-creation-e2e/$RUN_ID}"
IOS_ROOT="${NEXUS_IOS_ROOT:-/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub}"
BACKEND_URL="${CONTENT_E2E_BACKEND_URL:-http://127.0.0.1:${NEXUS_LOCAL_PORT_TS:-8200}}"
CONTENT_ENGINE_URL="${CONTENT_E2E_CONTENT_ENGINE_URL:-http://127.0.0.1:${NEXUS_LOCAL_PORT_PY:-8100}}"
INTERNAL_API_SECRET="${CONTENT_E2E_INTERNAL_API_SECRET:-}"
IOS_AUTH_FILE="${CONTENT_E2E_IOS_AUTH_FILE:-$ROOT/.local/full-nexus/local-ios-auth.json}"
IOS_AUTH_FALLBACK_FILE="${CONTENT_E2E_IOS_AUTH_FALLBACK_FILE:-/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/.local/full-nexus/local-ios-auth.json}"

CONTENT_UI_CLASSES=(
  ContentCreationLiveWorkflowUITests
  ContentStudioShellUITests
  ContentStudioTodayStatesUITests
  ContentStudioPipelineUITests
  ContentStudioComposerUITests
  ContentStudioQuickCaptureUITests
)

BACKEND_CONTENT_TESTS=(
  __tests__/state/saved-ideas-scope.test.ts
  __tests__/api/content-topic-context.test.ts
  __tests__/api/content-script-utils.test.ts
  __tests__/api/content-script-route-utils.test.ts
  __tests__/api/content-script-duration.test.ts
  __tests__/services/script-pipeline.test.ts
  __tests__/services/content-research-package.test.ts
  __tests__/services/content-script-quality.test.ts
  __tests__/services/content-generation-quality.test.ts
  __tests__/services/content-agency.test.ts
  __tests__/api/content-agency-routes.test.ts
  __tests__/services/content-radar-engine.test.ts
  __tests__/services/content-discovery-scope.test.ts
  __tests__/api/content-home-route.test.ts
  __tests__/api/content-ideas-routes.test.ts
  __tests__/api/content-pipeline-routes.test.ts
  __tests__/api/content-reference-routes.test.ts
  __tests__/api/content-creator-profile-routes.test.ts
  __tests__/state/content-creator-profile.test.ts
  __tests__/services/content-memory-profile.test.ts
  __tests__/services/content-learning-store.test.ts
  __tests__/state/content-radar-feedback.test.ts
  __tests__/state/content-performance-aggregate.test.ts
  __tests__/agents/content-operational-agents.test.ts
  __tests__/agents/voice-evolution-agent.test.ts
  __tests__/agents/voice-evolution-multi-tenant.test.ts
  __tests__/agents/voice-evolution-qa-validation.test.ts
)

if [[ "${CONTENT_E2E_SKIP_LIVE_IOS:-0}" == "1" ]]; then
  CONTENT_UI_CLASSES=("${CONTENT_UI_CLASSES[@]:1}")
fi

if [[ -n "${CONTENT_E2E_IOS_CLASSES:-}" ]]; then
  # shellcheck disable=SC2206
  CONTENT_UI_CLASSES=($CONTENT_E2E_IOS_CLASSES)
fi

if [[ -n "${CONTENT_E2E_BACKEND_TESTS:-}" ]]; then
  # shellcheck disable=SC2206
  BACKEND_CONTENT_TESTS=($CONTENT_E2E_BACKEND_TESTS)
fi

mkdir -p "$EVIDENCE_DIR"

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'
}

write_runtime_identity() {
  local commit branch node_image py_image health ready
  local secret
  secret="$(internal_secret)"
  commit="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
  branch="$(git -C "$ROOT" branch --show-current 2>/dev/null || true)"
  node_image="$(docker image inspect nexus-hub-node:local --format '{{.Id}}' 2>/dev/null || true)"
  py_image="$(docker image inspect nexus-hub-content-engine:local --format '{{.Id}}' 2>/dev/null || true)"
  health="$(curl -fsS "$BACKEND_URL/health" 2>/dev/null || true)"
  ready="$(curl -fsS -H "X-Internal-Secret: $secret" "$CONTENT_ENGINE_URL/ready" 2>/dev/null || true)"
  cat > "$EVIDENCE_DIR/runtime-identity.json" <<EOF
{
  "runId": "$RUN_ID",
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "backendUrl": "$BACKEND_URL",
  "contentEngineUrl": "$CONTENT_ENGINE_URL",
  "commit": $(printf '%s' "$commit" | json_escape),
  "branch": $(printf '%s' "$branch" | json_escape),
  "nodeImage": $(printf '%s' "$node_image" | json_escape),
  "contentEngineImage": $(printf '%s' "$py_image" | json_escape),
  "health": $(printf '%s' "$health" | json_escape),
  "contentEngineReady": $(printf '%s' "$ready" | json_escape)
}
EOF
  echo "Runtime identity: $EVIDENCE_DIR/runtime-identity.json"
}

internal_secret() {
  if [[ -n "$INTERNAL_API_SECRET" ]]; then
    printf '%s' "$INTERNAL_API_SECRET"
    return 0
  fi
  if [[ -f "$ROOT/.env.local" ]]; then
    awk -F= '/^INTERNAL_API_SECRET=/{print $2; exit}' "$ROOT/.env.local"
    return 0
  fi
  printf '%s' "local-dev-internal-api-secret"
}

auth_payload_b64() {
  [[ -s "$IOS_AUTH_FILE" ]] || return 0
  python3 - "$IOS_AUTH_FILE" <<'PY'
import base64
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
data = path.read_bytes()
if len(data) <= 16 * 1024:
    print(base64.b64encode(data).decode("ascii"))
PY
}

write_manual_checklist() {
  cat > "$EVIDENCE_DIR/felipe-script-quality-checklist.md" <<'EOF'
# Felipe Manual Script Quality Checklist

Use the latest local backend/content-engine container and iOS Simulator opened by this run. The seeded non-production scenario fixture for this run is `felipe-script-quality-scenarios.json` in the same evidence directory.

For each generated script, answer:
- Does it feel on-brand for the active voice card?
- Does it use the selected pillar/audience rather than generic creator advice?
- Is the hook specific, filmable, and non-template-like?
- Is the script creative enough to be useful without a major rewrite?
- Are factual/news claims source-aware and reviewable?
- Are degraded/mock/no-source states visible and non-publishable?
- Is the format native to the platform?
- Does the CTA match the brand and one clear next action?
- Did feedback/memory change the next generation in the expected direction?
EOF
  echo "Manual checklist: $EVIDENCE_DIR/felipe-script-quality-checklist.md"
}

write_manual_scenarios_fixture() {
  cat > "$EVIDENCE_DIR/felipe-script-quality-scenarios.json" <<'EOF'
{
  "purpose": "Non-production manual Content Studio script-quality scenarios for Felipe.",
  "usage": "Use these scenarios in the authenticated local simulator session opened by this run. They are fixtures for manual judgment, not production data.",
  "scenarios": [
    {
      "id": "weak-profile-no-voice-dna",
      "profile": { "tone": [], "audience": "", "language": "en", "pillars": [], "bannedPhrases": [] },
      "topic": "How solo creators can avoid generic AI content",
      "format": "YouTube Shorts",
      "researchMode": "none",
      "expectedReviewSignals": ["missing voice facts", "review-required no-source provenance", "setup questions"]
    },
    {
      "id": "strong-profile-clear-pillars",
      "profile": {
        "tone": ["direct", "operator-minded", "specific"],
        "audience": "technical founders building AI products solo",
        "language": "en",
        "pillars": ["AI product systems", "solo operator leverage", "evidence-backed execution"],
        "bannedPhrases": ["game changer", "unlock your potential"]
      },
      "topic": "Why your AI product demo should show failure states",
      "format": "YouTube",
      "researchMode": "real-source",
      "expectedReviewSignals": ["on-brand POV", "pillar-specific angle", "source-aware proof"]
    },
    {
      "id": "conflicting-voice-rules",
      "profile": {
        "tone": ["warm and concise", "aggressive hype", "calm evidence-led"],
        "audience": "early SaaS founders",
        "language": "en",
        "pillars": ["product judgment", "automation strategy"],
        "bannedPhrases": ["crush it", "go viral"]
      },
      "topic": "When to stop adding AI agents to a workflow",
      "format": "LinkedIn Post",
      "researchMode": "none",
      "expectedReviewSignals": ["voice conflict warning", "non-generic rewrite", "clear CTA style"]
    },
    {
      "id": "degraded-research-not-publishable",
      "profile": {
        "tone": ["precise", "skeptical"],
        "audience": "builders who need trustworthy research",
        "language": "en",
        "pillars": ["research provenance", "AI operations"]
      },
      "topic": "Latest changes in creator monetization tools",
      "format": "X Thread",
      "researchMode": "degraded",
      "expectedReviewSignals": ["visible non-publishable state", "no fake trend claims", "refresh research prompt"]
    },
    {
      "id": "competitor-reference-avoid-copying",
      "profile": {
        "tone": ["analytical", "plainspoken"],
        "audience": "AI workflow builders",
        "language": "en",
        "pillars": ["original positioning", "workflow design"]
      },
      "topic": "Reacting to a competitor's AI workflow video without copying it",
      "format": "Reel",
      "researchMode": "competitor-reference",
      "expectedReviewSignals": ["competitor pattern used only as diagnosis", "originality constraint", "no copied hook"]
    },
    {
      "id": "high-risk-claim-review",
      "profile": {
        "tone": ["careful", "evidence-first"],
        "audience": "founders evaluating AI productivity claims",
        "language": "en",
        "pillars": ["AI evidence", "operator productivity"]
      },
      "topic": "Does using AI agents increase team productivity by 50 percent?",
      "format": "Blog",
      "researchMode": "real-source-required",
      "expectedReviewSignals": ["high-risk claim review", "source-backed caveats", "no unsupported statistics"]
    },
    {
      "id": "multi-format-adaptation",
      "profile": {
        "tone": ["sharp", "helpful"],
        "audience": "solo technical creators",
        "language": "en",
        "pillars": ["content systems", "AI product building"]
      },
      "topic": "Turn one research-backed idea into platform-native assets",
      "formats": ["YouTube", "YouTube Shorts", "TikTok", "LinkedIn Post", "X Thread", "Newsletter", "Carousel"],
      "researchMode": "real-source",
      "expectedReviewSignals": ["platform-native structure", "format-specific CTA", "consistent voice across formats"]
    }
  ]
}
EOF
  echo "Manual scenarios: $EVIDENCE_DIR/felipe-script-quality-scenarios.json"
}

run_backend_checks() {
  npm run typecheck
  npx vitest run "${BACKEND_CONTENT_TESTS[@]}"
  (
    cd "$ROOT/content-engine"
    PYTHON_BIN="$ROOT/content-engine/.venv/bin/python"
    [[ -x "$PYTHON_BIN" ]] || PYTHON_BIN=python3
    "$PYTHON_BIN" -m pytest tests/test_research_provenance_contract.py
  )
}

boot_latest_local_containers() {
  if [[ "${CONTENT_E2E_SKIP_CONTAINER:-0}" == "1" ]]; then
    echo "CONTENT_E2E_SKIP_CONTAINER=1; skipping local container boot."
    return 0
  fi
  scripts/local-up.sh
  local secret
  secret="$(internal_secret)"
  curl -fsS "$BACKEND_URL/health" > "$EVIDENCE_DIR/backend-health.json"
  curl -fsS -H "X-Internal-Secret: $secret" "$CONTENT_ENGINE_URL/ready" > "$EVIDENCE_DIR/content-engine-ready.json"
  write_runtime_identity
}

run_ios_content_studio_suites() {
  if [[ "${CONTENT_E2E_SKIP_IOS:-0}" == "1" ]]; then
    echo "CONTENT_E2E_SKIP_IOS=1; skipping iOS simulator suites."
    return 0
  fi
  if [[ ! -d "$IOS_ROOT" ]]; then
    echo "ERROR: iOS checkout not found at $IOS_ROOT" >&2
    return 2
  fi
  if [[ -z "${IOS_SIM_UDID:-}" ]]; then
    echo "ERROR: IOS_SIM_UDID is required by the iOS UI runner." >&2
    echo "       Boot a simulator or set IOS_SIM_UDID before rerunning." >&2
    return 2
  fi
  prepare_ios_auth
  local inline_auth_payload
  inline_auth_payload="${NEXUS_LOCAL_AUTH_IMPORT_JSON_B64:-}"
  if [[ -z "$inline_auth_payload" ]]; then
    inline_auth_payload="$(auth_payload_b64)"
  fi
  (
    cd "$IOS_ROOT"
    export IOS_SCHEME="${IOS_SCHEME:-Nexus Hub Debug UI Smoke}"
    export NEXUS_API_BASE_URL="$BACKEND_URL"
    export NEXUS_LOCAL_ENGINE_BASE_URL="$BACKEND_URL"
    export NEXUS_LOCAL_AUTH_IMPORT_PATH="$IOS_AUTH_FILE"
    export NEXUS_BACKEND_REPO_PATH="$ROOT"
    export NEXUS_LIVE_GENERATE_SCRIPT="${NEXUS_LIVE_GENERATE_SCRIPT:-0}"
    if [[ -n "$inline_auth_payload" ]]; then
      export NEXUS_LOCAL_AUTH_IMPORT_JSON_B64="$inline_auth_payload"
    fi
    export IOS_UI_SUITE_LOG_DIR="${IOS_UI_SUITE_LOG_DIR:-$EVIDENCE_DIR/ios-ui-logs}"
    export IOS_KEEP_SIM_BOOTED_AFTER_SUITE="${IOS_KEEP_SIM_BOOTED_AFTER_SUITE:-1}"
    scripts/ios-ui-suite-chunked-test.sh "${CONTENT_UI_CLASSES[@]}"
  )
  launch_ios_manual_session
}

prepare_ios_auth() {
  if [[ "${CONTENT_E2E_PREPARE_IOS_AUTH:-1}" != "1" ]]; then
    return 0
  fi
  echo "Preparing iOS local auth import: $IOS_AUTH_FILE"
  NEXUS_LOCAL_BASE_URL="$BACKEND_URL" \
    NEXUS_LOCAL_AUTH_IMPORT_PATH="$IOS_AUTH_FILE" \
    node scripts/local-ios-debug-auth.mjs > "$EVIDENCE_DIR/ios-auth.json"
  if [[ -n "$IOS_AUTH_FALLBACK_FILE" && "$IOS_AUTH_FALLBACK_FILE" != "$IOS_AUTH_FILE" ]]; then
    mkdir -p "$(dirname "$IOS_AUTH_FALLBACK_FILE")"
    cp "$IOS_AUTH_FILE" "$IOS_AUTH_FALLBACK_FILE"
  fi
  echo "iOS auth identity: $EVIDENCE_DIR/ios-auth.json"
}

launch_ios_manual_session() {
  if [[ "${CONTENT_E2E_LAUNCH_IOS_MANUAL_SESSION:-1}" != "1" ]]; then
    return 0
  fi
  if ! command -v xcrun >/dev/null 2>&1; then
    echo "WARN: xcrun not found; cannot launch the manual iOS review session." >&2
    return 0
  fi
  if [[ ! -s "$IOS_AUTH_FILE" ]]; then
    echo "WARN: iOS auth file missing; manual simulator launch will remain signed out." >&2
  fi
  local inline_auth_payload
  inline_auth_payload="${NEXUS_LOCAL_AUTH_IMPORT_JSON_B64:-}"
  if [[ -z "$inline_auth_payload" ]]; then
    inline_auth_payload="$(auth_payload_b64)"
  fi
  echo "Launching authenticated iOS manual review session on $IOS_SIM_UDID"
  if [[ -n "$inline_auth_payload" ]]; then
    SIMCTL_CHILD_NEXUS_LOCAL_AUTH_IMPORT_PATH="$IOS_AUTH_FILE" \
      SIMCTL_CHILD_NEXUS_LOCAL_AUTH_IMPORT_JSON_B64="$inline_auth_payload" \
      SIMCTL_CHILD_NEXUS_LIVE_GENERATE_SCRIPT="${NEXUS_LIVE_GENERATE_SCRIPT:-0}" \
      xcrun simctl launch --terminate-running-process "$IOS_SIM_UDID" me.nexushub.app \
        -NexusUITestMode YES \
        -nexus_allow_local_backend YES \
        -nexus_base_url "$BACKEND_URL" \
        -nexus_debug_local_auth_import YES \
        > "$EVIDENCE_DIR/ios-manual-launch.txt"
  else
    SIMCTL_CHILD_NEXUS_LOCAL_AUTH_IMPORT_PATH="$IOS_AUTH_FILE" \
      SIMCTL_CHILD_NEXUS_LIVE_GENERATE_SCRIPT="${NEXUS_LIVE_GENERATE_SCRIPT:-0}" \
      xcrun simctl launch --terminate-running-process "$IOS_SIM_UDID" me.nexushub.app \
        -NexusUITestMode YES \
        -nexus_allow_local_backend YES \
        -nexus_base_url "$BACKEND_URL" \
        -nexus_debug_local_auth_import YES \
        > "$EVIDENCE_DIR/ios-manual-launch.txt"
  fi
  echo "iOS manual launch: $EVIDENCE_DIR/ios-manual-launch.txt"
}

main() {
  echo "== Content Creation E2E Validation =="
  echo "Evidence dir: $EVIDENCE_DIR"
  write_manual_scenarios_fixture
  write_manual_checklist
  run_backend_checks
  boot_latest_local_containers
  run_ios_content_studio_suites
  echo "Content Creation E2E validation completed."
}

main "$@"
