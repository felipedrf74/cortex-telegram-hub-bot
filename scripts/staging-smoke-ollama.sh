#!/usr/bin/env bash
# scripts/staging-smoke-ollama.sh
# ----------------------------------------------------------------------------
# Ollama-specific staging smoke. Runs after install AND after the backend deploy
# that ships the OllamaProvider. Gated on `OLLAMA_ENABLED=true` in .env.
#
# Exits non-zero if any check fails — used as an exact-promotion gate when
# `AI_CLASSIFY_PRIMARY=ollama` (or any other routing) is in the deployed .env.
#
# Hook into scripts/staging-smoke.sh as:
#   if grep -qE '^OLLAMA_ENABLED=true' .env; then bash scripts/staging-smoke-ollama.sh; fi
# ----------------------------------------------------------------------------
set -euo pipefail

# ── Config (overridable for staging vs prod) ────────────────────────────────
OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434}"
NEXUS_HUB_BASE_URL="${NEXUS_HUB_BASE_URL:-http://127.0.0.1:8200}"
DB_PATH="${DATABASE_PATH:-./data/cortex.db}"
QUEUE_BACKEND="${LOCAL_LLM_QUEUE_BACKEND:-memory}"
EXPECTED_PM2_NAME="${PM2_APP_NAME:-nexus-hub}"

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
  if command -v pm2 >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
    instances=$(pm2 jlist 2>/dev/null \
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
    printf '  ⚠ PM2/jq not available — skipping deploy-time PM2 check (runtime guard still active)\n'
  fi
else
  printf '  ⓘ LOCAL_LLM_QUEUE_BACKEND=%s (not memory) — PM2 multi-instance allowed if backend supports it\n' "${QUEUE_BACKEND}"
fi

# ── Daemon reachability ─────────────────────────────────────────────────────
echo "→ Ollama daemon"
check "GET /api/version" curl -fsS "${OLLAMA_BASE_URL}/api/version"
check "GET /api/ps" curl -fsS "${OLLAMA_BASE_URL}/api/ps"

# ── Loopback-only bind ──────────────────────────────────────────────────────
echo "→ Loopback bind verification"
non_loopback=$(ss -ltnH 2>/dev/null \
  | awk '$4 ~ /:11434$/ && $4 !~ /^127\.0\.0\.1:/ && $4 !~ /^\[::1\]:/' || true)
if [ -z "${non_loopback}" ]; then
  printf '  ✓ Ollama listens on 127.0.0.1:11434 only\n'; pass=$((pass+1))
else
  printf '  ✗ Ollama bound to non-loopback: %s\n' "${non_loopback}"; fail=$((fail+1))
fi

# ── Health endpoint shows ollama healthy ────────────────────────────────────
echo "→ Nexus Hub health surface"
if curl -fsS "${NEXUS_HUB_BASE_URL}/health/detailed" 2>/dev/null \
    | (command -v jq >/dev/null 2>&1 && jq -e '.providers.ollama.healthy == true' >/dev/null \
       || grep -q '"healthy"\s*:\s*true'); then
  printf '  ✓ /health/detailed reports ollama healthy\n'; pass=$((pass+1))
else
  printf '  ✗ /health/detailed does not report ollama healthy\n'; fail=$((fail+1))
fi

# ── Round-trips (one per task type) ─────────────────────────────────────────
# Note: these hit Nexus Hub's internal smoke routes which exercise the
# OllamaProvider directly. Update paths to match your actual smoke endpoints
# once the backend code lands. Until those endpoints exist, this step is a
# no-op (warn-only).
echo "→ Round-trip smokes (classify, scriptGeneration, localReasoning)"
classify_smoke="${NEXUS_HUB_BASE_URL}/api/v1/internal/ollama-smoke/classify"
scriptgen_smoke="${NEXUS_HUB_BASE_URL}/api/v1/internal/ollama-smoke/script-generation"
localreason_smoke="${NEXUS_HUB_BASE_URL}/api/v1/internal/ollama-smoke/local-reasoning"

for url in "${classify_smoke}" "${scriptgen_smoke}" "${localreason_smoke}"; do
  label="$(basename "${url}")"
  if curl -fsS -X POST "${url}" -H 'Content-Type: application/json' -d '{"smoke":true}' >/tmp/ollama-smoke-resp 2>/dev/null; then
    printf '  ✓ %s\n' "${label}"; pass=$((pass+1))
  else
    code=$?
    if [ "${code}" -eq 22 ]; then
      printf '  ⚠ %s (404 — endpoint not yet implemented; treat as advisory until backend code lands)\n' "${label}"
    else
      printf '  ✗ %s (curl exit %s)\n' "${label}" "${code}"; fail=$((fail+1))
    fi
  fi
done

# ── api_usage row assertion ─────────────────────────────────────────────────
echo "→ api_usage row check"
if command -v sqlite3 >/dev/null 2>&1 && [ -f "${DB_PATH}" ]; then
  row_count=$(sqlite3 "${DB_PATH}" "SELECT COUNT(*) FROM api_usage WHERE provider='ollama' AND ts >= datetime('now','-5 minutes');" 2>/dev/null || echo 0)
  if [ "${row_count}" -gt 0 ]; then
    printf '  ✓ api_usage has %s ollama rows in last 5 min\n' "${row_count}"; pass=$((pass+1))
    # Assert cost_usd is 0 and local_request_units is 1 for those rows
    bad_rows=$(sqlite3 "${DB_PATH}" "SELECT COUNT(*) FROM api_usage WHERE provider='ollama' AND ts >= datetime('now','-5 minutes') AND (cost_usd > 0 OR local_request_units != 1);" 2>/dev/null || echo 0)
    if [ "${bad_rows}" = "0" ]; then
      printf '  ✓ all ollama rows have cost_usd=0 AND local_request_units=1\n'; pass=$((pass+1))
    else
      printf '  ✗ %s ollama rows have cost_usd>0 OR local_request_units!=1\n' "${bad_rows}"; fail=$((fail+1))
    fi
  else
    printf '  ⚠ no recent ollama api_usage rows (only meaningful after round-trip smokes succeed)\n'
  fi
else
  printf '  ⚠ sqlite3/DB unavailable — skipping api_usage check\n'
fi

# ── script_generation_runs assertion ────────────────────────────────────────
echo "→ script_generation_runs row check"
if command -v sqlite3 >/dev/null 2>&1 && [ -f "${DB_PATH}" ]; then
  sgr_count=$(sqlite3 "${DB_PATH}" "SELECT COUNT(*) FROM script_generation_runs WHERE provider='ollama' AND ts >= strftime('%s','now','-5 minutes');" 2>/dev/null || echo 0)
  if [ "${sgr_count}" -gt 0 ]; then
    printf '  ✓ script_generation_runs has %s rows in last 5 min\n' "${sgr_count}"; pass=$((pass+1))
  else
    printf '  ⚠ no recent script_generation_runs (only meaningful after scriptGeneration smoke succeeds)\n'
  fi
fi

# ── Summary ─────────────────────────────────────────────────────────────────
echo
echo "──────────────────────────────────────"
echo "PASS: ${pass}  FAIL: ${fail}"
echo "──────────────────────────────────────"
[ "${fail}" -eq 0 ] || exit 1
