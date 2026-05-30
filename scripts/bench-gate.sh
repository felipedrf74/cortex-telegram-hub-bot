#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# scripts/bench-gate.sh — WP-11 (D3 latency fast-model + benchmark gate)
#
# Runs the `burst5` phase of the ChatCoreV2 planner benchmark (5 concurrent
# requests against Ollama) and FORWARDS its exit code. The benchmark applies a
# p95 ≤ CHAT_CORE_V2_BURST5_P95_MS gate (default 5000ms) for the burst5 suite.
#
#   ⚠️  PROXY GATE — requires GPU/VPS validation.
#   This runs against whatever Ollama daemon is reachable from THIS host. On a
#   developer laptop (CPU / small GPU) the p95 it measures is NOT the production
#   latency. The authoritative D3 latency number must be measured on the GPU/VPS
#   box. Treat a local pass/fail as a smoke proxy only.
#
# Graceful skip: if Ollama is absent / not reachable, this exits 0 with a clear
# SKIP message. This is intentional so CI and opt-in pre-push never fail merely
# because no local model server is running.
#
# Usage:
#   bash scripts/bench-gate.sh
#   CHAT_CORE_V2_BURST5_P95_MS=4000 bash scripts/bench-gate.sh
#   OLLAMA_BASE_URL=http://127.0.0.1:11434 bash scripts/bench-gate.sh
# ─────────────────────────────────────────────────────
set -euo pipefail

OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434}"
P95_GATE_MS="${CHAT_CORE_V2_BURST5_P95_MS:-5000}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "─────────────────────────────────────────────────────"
echo "WP-11 bench-gate (burst5, p95 ≤ ${P95_GATE_MS}ms)"
echo "⚠️  PROXY — requires GPU/VPS validation."
echo "    Local hardware latency is NOT production latency."
echo "    The authoritative D3 number is measured on the GPU/VPS box."
echo "    Ollama: ${OLLAMA_BASE_URL}"
echo "─────────────────────────────────────────────────────"

# ── Graceful Ollama-absent skip ──────────────────────────────────────────────
if ! command -v curl >/dev/null 2>&1; then
  echo "SKIP: curl not available — cannot probe Ollama. Skipping bench gate (exit 0)."
  exit 0
fi

if ! curl -sf --max-time 3 "${OLLAMA_BASE_URL}/api/version" >/dev/null 2>&1; then
  echo "SKIP: Ollama not reachable at ${OLLAMA_BASE_URL} — skipping bench gate (exit 0)."
  echo "      (Run an Ollama daemon locally, or run this on the GPU/VPS box, to exercise the gate.)"
  exit 0
fi

echo "→ Ollama reachable. Running burst5 benchmark..."

# Forward the benchmark's exit code verbatim. The burst5 suite applies its own
# p95 gate inside the harness (process.exitCode = 1 on failure).
set +e
npx tsx "${ROOT}/scripts/llm/chatcore-v2-planner-benchmark.ts" \
  --suite=burst5 \
  --warmup-runs=1
BENCH_EXIT=$?
set -e

if [ "${BENCH_EXIT}" -eq 0 ]; then
  echo "✅ bench-gate PASS (proxy). Validate the authoritative number on GPU/VPS."
else
  echo "❌ bench-gate FAIL (proxy, exit ${BENCH_EXIT}). p95 over ${P95_GATE_MS}ms or request/schema failure."
fi

exit "${BENCH_EXIT}"
