#!/usr/bin/env bash
# scripts/staging-smoke-ollama.sh
# ----------------------------------------------------------------------------
# Ollama-specific staging smoke. Runs after install AND after the backend deploy
# that ships the OllamaProvider. Gated on `OLLAMA_ENABLED=true` in .env.
#
# Exits non-zero if any required check fails. Authenticated backend checks and
# the direct 3B round-trip are promotion gates; there are no warn-only routes.
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
SMALL_ONLY_MODEL="qwen2.5:3b-instruct-q4_K_M"
DISALLOWED_REASONING_MODEL_TOKEN_PATTERN='(^|[^a-z0-9])(flash|nano|mini|haiku|lite|classifier|fast)([^a-z0-9]|$)'
INVENTORY_PHASE="${OLLAMA_INVENTORY_PHASE:-strict}"
case "${INVENTORY_PHASE}" in
  strict|pre_cleanup|governed) ;;
  *) printf 'FAIL: OLLAMA_INVENTORY_PHASE must be strict, pre_cleanup, or governed\n' >&2; exit 2 ;;
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

echo "→ Small-only model inventory"
if [ "${INVENTORY_PHASE}" = strict ]; then
  inventory_filter='.models | length == 1 and .[0].name == $model'
elif [ "${INVENTORY_PHASE}" = pre_cleanup ]; then
  # The two 24-hour routing soaks happen before owner-authorized deletion.
  # During that explicit phase the three known deletion targets may remain on
  # disk, but no alias/extra tag is accepted and the loaded-model check below
  # still permits only the retained 3B model.
  inventory_filter='[.models[].name] | sort == ([$model, $remove1, $remove2, $remove3] | sort)'
else
  # The canonical release gate has to remain valid on both sides of the
  # owner-authorized cleanup. It accepts exactly the reviewed four-tag
  # pre-cleanup inventory or the sole retained tag, never a partial/extra set.
  inventory_filter='([.models[].name] | sort) as $names
    | ($names == ([$model] | sort)
      or $names == ([$model, $remove1, $remove2, $remove3] | sort))'
fi
if curl -fsS "${OLLAMA_BASE_URL}/api/tags" \
    | jq -e --arg model "${SMALL_ONLY_MODEL}" \
      --arg remove1 'gemma2:2b-instruct-q4_K_M' \
      --arg remove2 'qwen3.6:27b-q4_K_M' \
      --arg remove3 'qwen3.6:35b-a3b-q4_K_M' \
      "${inventory_filter}" >/dev/null; then
  printf '  ✓ inventory matches %s phase policy\n' "${INVENTORY_PHASE}"; pass=$((pass+1))
else
  printf '  ✗ model inventory violates %s phase policy\n' "${INVENTORY_PHASE}"; fail=$((fail+1))
fi

if curl -fsS "${OLLAMA_BASE_URL}/api/ps" \
    | jq -e --arg model "${SMALL_ONLY_MODEL}" \
      'all(.models[]?; .name == $model)' >/dev/null; then
  printf '  ✓ every loaded model satisfies the small-only policy\n'; pass=$((pass+1))
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
    --arg model "${SMALL_ONLY_MODEL}" \
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
  printf '  ✓ live PM2 config is fail-closed cloud reasoning plus exact Gemini/3B runtime roles\n'; pass=$((pass+1))
else
  printf '  ✗ live PM2 config violates the fail-closed cloud reasoning or explicit Gemini/3B role policy\n'; fail=$((fail+1))
fi

# ── Required direct 3B round-trip ───────────────────────────────────────────
echo "→ Required small-only inference round-trip"
smoke_payload=$(jq -nc --arg model "${SMALL_ONLY_MODEL}" '{
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
    && jq -e --arg model "${SMALL_ONLY_MODEL}" \
      '.model == $model and (.message.content | fromjson | .ok == true)' \
      "${SMOKE_RESPONSE_FILE}" >/dev/null; then
  printf '  ✓ 3B structured round-trip passed\n'; pass=$((pass+1))
else
  printf '  ✗ 3B structured round-trip failed\n'; fail=$((fail+1))
fi

# ── Summary ─────────────────────────────────────────────────────────────────
echo
echo "──────────────────────────────────────"
echo "PASS: ${pass}  FAIL: ${fail}"
echo "──────────────────────────────────────"
[ "${fail}" -eq 0 ] || exit 1
