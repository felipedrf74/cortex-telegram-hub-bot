#!/usr/bin/env bash
# scripts/staging-smoke-ollama.sh
# ----------------------------------------------------------------------------
# Legacy PM2-topology compatibility smoke retained for historical release
# rehearsal only. Current signed-OCI production readiness uses the attended
# systemd/socket transactions and the pull-only release poller's Compose smoke;
# the installer no longer directs operators to this script.
#
# Exits non-zero if any required check fails. Authenticated backend checks and
# the direct manifest-model round-trip are promotion gates; there are no
# warn-only routes.
#
# Hook into scripts/staging-smoke.sh as:
#   if grep -qE '^OLLAMA_ENABLED=true' .env; then bash scripts/staging-smoke-ollama.sh; fi
# ----------------------------------------------------------------------------
set -euo pipefail

# ── Config (overridable for staging vs prod) ────────────────────────────────
OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434}"
NEXUS_HUB_BASE_URL="${NEXUS_HUB_BASE_URL:-http://127.0.0.1:8200}"
QUEUE_BACKEND="${LOCAL_LLM_QUEUE_BACKEND:-memory}"
EXPECTED_PM2_NAME="${PM2_APP_NAME:-nexus-hub}"
PM2_BIN="${PM2_BIN:-$(command -v pm2 2>/dev/null || true)}"
MODEL_MANIFEST_PATH="${LOCAL_MODEL_MANIFEST_PATH:-config/local-model-manifest.json}"
DISALLOWED_REASONING_MODEL_TOKEN_PATTERN='(^|[^a-z0-9])(flash|nano|mini|haiku|lite|classifier|fast)([^a-z0-9]|$)'
INVENTORY_PHASE="${OLLAMA_INVENTORY_PHASE:-final}"
case "${INVENTORY_PHASE}" in
  final|release) ;;
  *) printf 'FAIL: OLLAMA_INVENTORY_PHASE must be final or release\n' >&2; exit 2 ;;
esac

# Read the health token without sourcing the full application environment.
HEALTH_TOKEN_VALUE="${HEALTH_TOKEN:-}"
if [ -z "${HEALTH_TOKEN_VALUE}" ] && [ -f .env ]; then
  HEALTH_TOKEN_VALUE=$(sed -n 's/^HEALTH_TOKEN=//p' .env | tail -n 1)
fi
if [ -z "${HEALTH_TOKEN_VALUE}" ]; then
  printf 'FAIL: HEALTH_TOKEN is required for authenticated Ollama staging smoke\n' >&2
  exit 2
fi

AUTH_HEADER_FILE=$(mktemp)
SMOKE_RESPONSE_FILE=$(mktemp)
cleanup() { rm -f "${AUTH_HEADER_FILE}" "${SMOKE_RESPONSE_FILE}"; }
trap cleanup EXIT
chmod 600 "${AUTH_HEADER_FILE}" "${SMOKE_RESPONSE_FILE}"
printf 'Authorization: Bearer %s\n' "${HEALTH_TOKEN_VALUE}" > "${AUTH_HEADER_FILE}"
unset HEALTH_TOKEN_VALUE

for required_command in curl jq ss; do
  if ! command -v "${required_command}" >/dev/null 2>&1; then
    printf 'FAIL: required command is missing: %s\n' "${required_command}" >&2
    exit 3
  fi
done
if [ ! -f "${MODEL_MANIFEST_PATH}" ] || [ -L "${MODEL_MANIFEST_PATH}" ]; then
  printf 'FAIL: signed local-model manifest is missing or unsafe: %s\n' "${MODEL_MANIFEST_PATH}" >&2
  exit 3
fi
if ! jq -e '
    .schemaVersion == "nexus.local-model-manifest.v1"
    and (.selectionStatus == "control_only" or .selectionStatus == "production_selected")
    and (
      (.selectionStatus == "control_only" and .selectionEvidence == null)
      or
      (.selectionStatus == "production_selected"
        and (.selectionEvidence.winningCandidateId == .activeModelId)
        and (.selectionEvidence.benchmarkReportDigest | test("^sha256:[0-9a-f]{64}$"))
        and (.selectionEvidence.benchmarkCompletedAt
          | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{3})?Z$"))
        and (.selectionEvidence.benchmarkHostRollbackReceiptDigest | test("^sha256:[0-9a-f]{64}$"))
        and ([
          .selectionEvidence.corpusReference,
          .selectionEvidence.licenseReviewReference,
          .selectionEvidence.ownerApprovalReference
        ] | all(type == "string" and (length > 0) and (length <= 512))))
    )
    and (. as $root | any(.models[];
      .id == $root.activeModelId
      and .productionEligible == true
      and .evidenceStatus == "verified"
      and (.digest | test("^sha256:[0-9a-f]{64}$"))
      and ($root.selectionStatus != "production_selected" or .role == "winner")))
  ' "${MODEL_MANIFEST_PATH}" >/dev/null; then
  printf 'FAIL: signed local-model manifest has no verified digest-pinned active model\n' >&2
  exit 3
fi
ACTIVE_MODEL=$(jq -er '. as $root | .models[] | select(.id == $root.activeModelId) | .ollamaTag' \
  "${MODEL_MANIFEST_PATH}")
ACTIVE_MODEL_DIGEST=$(jq -er '. as $root | .models[] | select(.id == $root.activeModelId) | .digest | sub("^sha256:"; "")' \
  "${MODEL_MANIFEST_PATH}")
if [ -z "${PM2_BIN}" ] || [[ "${PM2_BIN}" != /* ]] || [ ! -x "${PM2_BIN}" ]; then
  printf 'FAIL: PM2_BIN must name an absolute executable PM2 launcher\n' >&2
  exit 3
fi

pass=0; fail=0
check() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    printf '  ✓ %s\n' "${label}"; pass=$((pass+1))
  else
    printf '  ✗ %s\n' "${label}"; fail=$((fail+1))
  fi
}

# ── PM2 single-instance check (A6) ──────────────────────────────────────────
# When LOCAL_LLM_QUEUE_BACKEND=memory, the in-process queue is single-instance
# only. PM2 must run exactly 1 worker for the nexus-hub app — otherwise two
# workers each think they have concurrency=1 and call Ollama in parallel.
echo "→ PM2 instance check (LOCAL_LLM_QUEUE_BACKEND=${QUEUE_BACKEND})"
if [ "${QUEUE_BACKEND}" = "memory" ]; then
  instances=$("${PM2_BIN}" jlist 2>/dev/null \
    | jq --arg name "${EXPECTED_PM2_NAME}" '[.[] | select(.name==$name)] | length' 2>/dev/null \
    || echo 0)
  if [ "${instances}" = "1" ]; then
    printf '  ✓ PM2 reports %s instances=1\n' "${EXPECTED_PM2_NAME}"
    pass=$((pass+1))
  else
    printf '  ✗ PM2 reports %s instances=%s (must be 1 for memory queue backend)\n' "${EXPECTED_PM2_NAME}" "${instances}"
    fail=$((fail+1))
  fi
else
  printf '  ⓘ LOCAL_LLM_QUEUE_BACKEND=%s (not memory) — PM2 multi-instance allowed if backend supports it\n' "${QUEUE_BACKEND}"
fi

# ── Daemon reachability ─────────────────────────────────────────────────────
echo "→ Ollama daemon"
check "GET /api/version" curl -fsS "${OLLAMA_BASE_URL}/api/version"
check "GET /api/ps" curl -fsS "${OLLAMA_BASE_URL}/api/ps"

echo "→ Signed-manifest model inventory"
if curl -fsS "${OLLAMA_BASE_URL}/api/tags" \
    | jq -e --arg model "${ACTIVE_MODEL}" --arg digest "${ACTIVE_MODEL_DIGEST}" '
      [.models[]
        | select((.name == $model or .model == $model)
          and ((.digest // "" | sub("^sha256:"; "")) == $digest))]
      | length == 1
    ' >/dev/null; then
  printf '  ✓ active model tag and digest match the signed manifest\n'; pass=$((pass+1))
else
  printf '  ✗ active model is absent or its digest differs from the signed manifest\n'; fail=$((fail+1))
fi

if curl -fsS "${OLLAMA_BASE_URL}/api/ps" \
    | jq -e --arg model "${ACTIVE_MODEL}" \
      '(.models | length) <= 1 and all(.models[]?; .name == $model or .model == $model)' >/dev/null; then
  printf '  ✓ at most one model is loaded and it matches the signed manifest\n'; pass=$((pass+1))
else
  printf '  ✗ a non-approved model is loaded\n'; fail=$((fail+1))
fi

# ── Loopback-only bind ──────────────────────────────────────────────────────
echo "→ Loopback bind verification"
non_loopback=$(ss -ltnH 2>/dev/null \
  | awk '$4 ~ /:11434$/ && $4 !~ /^127\.0\.0\.1:/ && $4 !~ /^\[::1\]:/' || true)
if [ -z "${non_loopback}" ]; then
  printf '  ✓ Ollama listens on 127.0.0.1:11434 only\n'; pass=$((pass+1))
else
  printf '  ✗ Ollama bound to non-loopback: %s\n' "${non_loopback}"; fail=$((fail+1))
fi

# ── Authenticated provider health and exact live routing policy ──────────────
echo "→ Authenticated Nexus Hub provider health"
if curl -fsS -H @"${AUTH_HEADER_FILE}" \
    "${NEXUS_HUB_BASE_URL}/health/detailed" > "${SMOKE_RESPONSE_FILE}" 2>/dev/null \
    && jq -e '
      .status == "healthy"
      and .providers.gemini.circuit.state == "CLOSED"
      and .providers.ollama.circuit.state == "CLOSED"
    ' "${SMOKE_RESPONSE_FILE}" >/dev/null; then
  printf '  ✓ authenticated /health/detailed reports Gemini and Ollama circuits closed\n'; pass=$((pass+1))
else
  printf '  ✗ authenticated /health/detailed cannot prove healthy Gemini/Ollama runtime\n'; fail=$((fail+1))
fi

echo "→ Exact PM2 routing/model policy"
if "${PM2_BIN}" jlist 2>/dev/null | jq -e \
    --arg name "${EXPECTED_PM2_NAME}" \
    --arg model "${ACTIVE_MODEL}" \
    --arg disallowed_model_pattern "${DISALLOWED_REASONING_MODEL_TOKEN_PATTERN}" '
      [.[] | select(.name == $name and .pm2_env.status == "online") | .pm2_env] as $apps
      | ($apps | length) == 1
        and $apps[0].OLLAMA_ENABLED == "true"
        and $apps[0].AI_CLASSIFY_PRIMARY == "gemini"
        and $apps[0].LOCAL_LLM_CLASSIFY_SHADOW == "true"
        and $apps[0].CHAT_CORE_V2_LOCAL_CHAT_LLM_MODE == "shadow"
        and $apps[0].LOCAL_LLM_EVALUATION_MODE == "false"
        and $apps[0].AI_SCRIPT_GENERATION_REQUIRE_LOCAL == "false"
        and $apps[0].AI_SCRIPT_GENERATION_FALLBACK == "approved_cloud_reasoning"
        and $apps[0].AI_LOCAL_REASONING_FALLBACK == "approved_cloud_reasoning"
        and $apps[0].CLOUD_REASONING_FALLBACK_ENABLED == "true"
        and $apps[0].CLOUD_REASONING_REQUIRE_APPROVED_MODEL == "true"
        and $apps[0].CLOUD_REASONING_ON_UNAPPROVED_MODEL == "fail_visibly"
        and $apps[0].CLOUD_REASONING_PRIVACY_MODE == "never"
        and $apps[0].CLOUD_REASONING_ALLOW_RAW_PRIVATE_DATA == "false"
        and (
          (($apps[0].CLOUD_REASONING_PROVIDER // "") | ascii_downcase) as $provider
          | (($apps[0].CLOUD_REASONING_MODEL // "") | ascii_downcase) as $reasoning_model
          | (($apps[0].APPROVED_REASONING_MODELS // "")
              | ascii_downcase
              | split(",")
              | map(gsub("^\\s+|\\s+$"; ""))) as $approved_models
          | (($provider == "gemini" and ($reasoning_model | startswith("gemini-")))
              or ($provider == "anthropic" and ($reasoning_model | startswith("claude-")))
              or ($provider == "openai"
                  and ($reasoning_model | test("^(gpt|chatgpt|o[1-9])([-.:]|$)"))))
            and ($approved_models | index($reasoning_model) != null)
            and (($reasoning_model | contains("preview")) | not)
            and (($reasoning_model | test($disallowed_model_pattern)) | not)
        )
        and $apps[0].OLLAMA_MODEL == $model
        and $apps[0].OLLAMA_CLASSIFIER_MODEL == $model
        and $apps[0].CHAT_CORE_V2_LOCAL_CHAT_MODEL == $model
        and $apps[0].CHAT_CORE_V2_LOCAL_CHAT_RECIPE_MODEL == $model
        and ($apps[0].CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL | ascii_downcase) == "off"
    ' >/dev/null; then
  printf '  ✓ live PM2 config is fail-closed cloud reasoning plus exact manifest-model roles\n'; pass=$((pass+1))
else
  printf '  ✗ live PM2 config violates the fail-closed cloud reasoning or manifest-model role policy\n'; fail=$((fail+1))
fi

# ── Required direct manifest-model round-trip ───────────────────────────────
echo "→ Required signed-manifest inference round-trip"
smoke_payload=$(jq -nc --arg model "${ACTIVE_MODEL}" '{
  model: $model,
  messages: [{role: "user", content: "Return JSON with ok=true."}],
  stream: false,
  think: false,
  keep_alive: 0,
  format: {
    type: "object",
    additionalProperties: false,
    required: ["ok"],
    properties: {ok: {type: "boolean", const: true}}
  },
  options: {num_ctx: 512, num_predict: 16, temperature: 0}
}')
if curl -fsS -X POST "${OLLAMA_BASE_URL}/api/chat" \
    -H 'Content-Type: application/json' \
    --data-binary "${smoke_payload}" > "${SMOKE_RESPONSE_FILE}" \
    && jq -e --arg model "${ACTIVE_MODEL}" \
      '.model == $model and (.message.content | fromjson | .ok == true)' \
      "${SMOKE_RESPONSE_FILE}" >/dev/null; then
  printf '  ✓ signed-manifest structured round-trip passed\n'; pass=$((pass+1))
else
  printf '  ✗ signed-manifest structured round-trip failed\n'; fail=$((fail+1))
fi

# ── Summary ─────────────────────────────────────────────────────────────────
echo
echo "──────────────────────────────────────"
echo "PASS: ${pass}  FAIL: ${fail}"
echo "──────────────────────────────────────"
[ "${fail}" -eq 0 ] || exit 1
