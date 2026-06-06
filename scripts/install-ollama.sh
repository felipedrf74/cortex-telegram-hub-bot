#!/usr/bin/env bash
# scripts/install-ollama.sh
# ----------------------------------------------------------------------------
# Install and configure Ollama as a systemd service on this VPS with
# operator-revised runtime flags sized for the qwen3.6:35b-a3b-q4_K_M model
# (~24 GB on disk) on a 30 GB / CPU-only host.
#
# Idempotent: safe to re-run. Tunable via env vars (see "Tunables" below).
#
# Operator notes:
#   - Loopback-only bind (OLLAMA_HOST=127.0.0.1:11434). Never expose to LAN/WAN.
#   - Primary model pull and operational-rollback model pull are BOTH fatal on
#     failure. No silent substitution. Operator must approve any alternate tag.
#   - MemoryHigh applies soft pressure (kernel reclaims pages) before MemoryMax
#     hard-kills. MemorySwapMax limits runaway swap thrash on a CPU-only host.
#   - To switch to the 27B rollback model after install:
#       sed -i 's/^OLLAMA_MODEL=.*/OLLAMA_MODEL=qwen3.6:27b-q4_K_M/' .env
#       sed -i 's/^OLLAMA_CLASSIFIER_MODEL=.*/OLLAMA_CLASSIFIER_MODEL=qwen3.6:27b-q4_K_M/' .env
#       pm2 restart nexus-hub
#     (Optional retune of systemd memory:
#       OLLAMA_MEMORY_HIGH=20G OLLAMA_MEMORY_MAX=23G bash scripts/install-ollama.sh )
# ----------------------------------------------------------------------------
set -euo pipefail

# ── Tunables ────────────────────────────────────────────────────────────────
REQUIRED_FREE_GB="${REQUIRED_FREE_GB:-40}"
PRIMARY_MODEL="${OLLAMA_PRIMARY_MODEL:-qwen3.6:35b-a3b-q4_K_M}"
ROLLBACK_MODEL="${OLLAMA_OPERATIONAL_ROLLBACK_MODEL:-qwen3.6:27b-q4_K_M}"

OLLAMA_MEMORY_HIGH="${OLLAMA_MEMORY_HIGH:-25G}"
OLLAMA_MEMORY_MAX="${OLLAMA_MEMORY_MAX:-28G}"
OLLAMA_MEMORY_SWAP_MAX="${OLLAMA_MEMORY_SWAP_MAX:-1G}"

OLLAMA_CONTEXT_LENGTH="${OLLAMA_CONTEXT_LENGTH:-8192}"
OLLAMA_MAX_QUEUE="${OLLAMA_MAX_QUEUE:-8}"
OLLAMA_LOAD_TIMEOUT="${OLLAMA_LOAD_TIMEOUT:-15m}"
OLLAMA_NICE="${OLLAMA_NICE:-5}"
OLLAMA_CPUWEIGHT="${OLLAMA_CPUWEIGHT:-70}"

# Option 3 (O3-A3): parameterized so Stage 3B can load both main +
# classifier models concurrently after the memory baseline is proven.
# Default stays at 1 — keep this as the safe single-model resident
# mode unless the operator explicitly opts in with
# `OLLAMA_MAX_LOADED_MODELS=2 bash scripts/install-ollama.sh`.
OLLAMA_MAX_LOADED_MODELS="${OLLAMA_MAX_LOADED_MODELS:-1}"

# ── Helpers ─────────────────────────────────────────────────────────────────
log() { printf '\n→ %s\n' "$*"; }
fail() { printf '\nFAIL: %s\n' "$*" >&2; exit "${2:-1}"; }

# ── Pre-flight ──────────────────────────────────────────────────────────────
log "Pre-flight: disk, memory, OS"
free_gb=$(df --output=avail -BG / | tail -1 | tr -dc '0-9')
[ "${free_gb}" -ge "${REQUIRED_FREE_GB}" ] \
  || fail "need ${REQUIRED_FREE_GB}G free on /, have ${free_gb}G" 1
total_ram_gb=$(free -g | awk '/^Mem:/ {print $2}')
echo "  disk free: ${free_gb}G · RAM total: ${total_ram_gb}G"
echo "  systemd memory: MemoryHigh=${OLLAMA_MEMORY_HIGH} MemoryMax=${OLLAMA_MEMORY_MAX} MemorySwapMax=${OLLAMA_MEMORY_SWAP_MAX}"
echo "  ollama daemon: NUM_PARALLEL=1 MAX_LOADED_MODELS=1 CTX=${OLLAMA_CONTEXT_LENGTH} QUEUE=${OLLAMA_MAX_QUEUE} LOAD_TIMEOUT=${OLLAMA_LOAD_TIMEOUT}"

# ── Install Ollama if missing ───────────────────────────────────────────────
if ! command -v ollama >/dev/null 2>&1; then
  log "Installing Ollama (official installer)"
  curl -fsSL https://ollama.com/install.sh | sh
else
  log "Ollama already installed: $(ollama --version 2>/dev/null || echo unknown)"
fi

# ── Models directory + ownership ────────────────────────────────────────────
sudo mkdir -p /var/lib/ollama/models
sudo chown -R ollama:ollama /var/lib/ollama || true

# ── systemd override ────────────────────────────────────────────────────────
log "Writing systemd override (/etc/systemd/system/ollama.service.d/override.conf)"
sudo mkdir -p /etc/systemd/system/ollama.service.d
sudo tee /etc/systemd/system/ollama.service.d/override.conf >/dev/null <<EOF
[Service]
# ── Ollama daemon env ─────────────────────────────────────────────────────
# Loopback only — never expose Ollama on a public interface.
Environment="OLLAMA_HOST=127.0.0.1:11434"
Environment="OLLAMA_MODELS=/var/lib/ollama/models"

# Concurrency: single-user, CPU-only. Daemon-side serialization.
# O3-A3: OLLAMA_MAX_LOADED_MODELS is parameterized (default 1). Set to 2
# only when Stage 3B memory baseline proves both the main model and the
# small classifier model can stay resident without swap thrash.
Environment="OLLAMA_MAX_LOADED_MODELS=${OLLAMA_MAX_LOADED_MODELS}"
Environment="OLLAMA_NUM_PARALLEL=1"
Environment="OLLAMA_MAX_QUEUE=${OLLAMA_MAX_QUEUE}"

# Context + KV cache: start 8K to stay under memory budget; promote to 16K
# only after a benchmark proves no sustained swap I/O.
Environment="OLLAMA_CONTEXT_LENGTH=${OLLAMA_CONTEXT_LENGTH}"
Environment="OLLAMA_KV_CACHE_TYPE=q8_0"
Environment="OLLAMA_FLASH_ATTENTION=1"

# Keep the active model warm forever (negative => never unload).
Environment="OLLAMA_KEEP_ALIVE=-1"

# Cold-load timeout: 24 GB model loading off NVMe takes minutes.
Environment="OLLAMA_LOAD_TIMEOUT=${OLLAMA_LOAD_TIMEOUT}"

# Disable any cloud-pull behavior in Ollama (defense-in-depth; we want pulls
# to be explicit, not lazy).
Environment="OLLAMA_NO_CLOUD=1"

# Quiet request logs (we observe via Nexus Hub structured logging instead).
Environment="OLLAMA_DEBUG_LOG_REQUESTS=0"

# ── Resource isolation ────────────────────────────────────────────────────
# Sized for the 24 GB 35B Q4_K_M model on a 30 GB box.
# MemoryHigh applies soft pressure BEFORE MemoryMax kills the daemon.
# MemorySwapMax blocks runaway swap thrash on CPU-only hardware.
MemoryHigh=${OLLAMA_MEMORY_HIGH}
MemoryMax=${OLLAMA_MEMORY_MAX}
MemorySwapMax=${OLLAMA_MEMORY_SWAP_MAX}

# Cooperate with nexus-hub and content-engine for CPU.
Nice=${OLLAMA_NICE}
CPUWeight=${OLLAMA_CPUWEIGHT}

# Restart=on-failure (NOT always) so a crash loop surfaces rather than masks.
Restart=on-failure
RestartSec=10
EOF

log "Reloading systemd + enabling/restarting ollama.service"
sudo systemctl daemon-reload
sudo systemctl enable --now ollama
sudo systemctl restart ollama

# ── Wait for daemon ─────────────────────────────────────────────────────────
log "Waiting for daemon"
for i in {1..30}; do
  if curl -sf http://127.0.0.1:11434/api/version >/dev/null; then break; fi
  sleep 1
done
curl -sf http://127.0.0.1:11434/api/version \
  || fail "daemon not up after 30s — check 'sudo journalctl -u ollama -n 50'" 1
echo "  daemon: $(curl -s http://127.0.0.1:11434/api/version)"

# ── Loopback-bind verification (CRITICAL safety check) ─────────────────────
log "Verifying loopback-only bind"
# Match listening sockets on :11434 and ensure none bind to a non-loopback addr.
non_loopback=$(ss -ltnH 2>/dev/null \
  | awk '$4 ~ /:11434$/ && $4 !~ /^127\.0\.0\.1:/ && $4 !~ /^\[::1\]:/' || true)
if [ -n "${non_loopback}" ]; then
  echo "${non_loopback}"
  fail "Ollama bound to a non-loopback address — refusing to continue" 4
fi
echo "  ok: listening on 127.0.0.1:11434 only"

# ── Pull primary model (FATAL on failure) ──────────────────────────────────
log "Pulling primary model: ${PRIMARY_MODEL} (fatal on failure)"
if ! ollama pull "${PRIMARY_MODEL}" 2>&1 | tee /tmp/ollama-pull-primary.log; then
  fail "primary model pull failed — see /tmp/ollama-pull-primary.log
  No silent substitution. Confirm intended tag or approve a substitute,
  then re-run with OLLAMA_PRIMARY_MODEL=<tag>" 2
fi

# ── Pull operational rollback model (FATAL on failure) ─────────────────────
log "Pulling operational-rollback model: ${ROLLBACK_MODEL} (fatal on failure)"
if ! ollama pull "${ROLLBACK_MODEL}" 2>&1 | tee /tmp/ollama-pull-rollback.log; then
  fail "rollback model pull failed — runbook depends on this being pre-pulled
  See /tmp/ollama-pull-rollback.log. Re-run with OLLAMA_OPERATIONAL_ROLLBACK_MODEL=<tag>
  to substitute, or fix the root cause and re-run." 3
fi

# ── Warm-load + smoke ───────────────────────────────────────────────────────
log "Warm-load + smoke (think:false, num_predict=16)"
ollama list
smoke_response=$(curl -sf http://127.0.0.1:11434/api/chat \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"${PRIMARY_MODEL}\",
    \"messages\": [{\"role\":\"user\",\"content\":\"reply with the single word ok\"}],
    \"stream\": false,
    \"think\": false,
    \"options\": {\"num_ctx\": 4096, \"num_predict\": 16, \"temperature\": 0},
    \"keep_alive\": -1
  }" || true)
if [ -z "${smoke_response}" ]; then
  fail "smoke call returned empty — check 'sudo journalctl -u ollama -n 50'" 5
fi
echo "${smoke_response}" | head -c 800
echo

# ── Done ────────────────────────────────────────────────────────────────────
log "Install complete"
echo "  daemon:    127.0.0.1:11434 (loopback only)"
echo "  primary:   ${PRIMARY_MODEL}"
echo "  rollback:  ${ROLLBACK_MODEL} (pre-pulled, NOT auto-retry)"
echo "  systemd:   MemoryHigh=${OLLAMA_MEMORY_HIGH} MemoryMax=${OLLAMA_MEMORY_MAX} MemorySwapMax=${OLLAMA_MEMORY_SWAP_MAX}"
echo
echo "Next steps (operator):"
echo "  1. Verify in browser: curl -s http://127.0.0.1:11434/api/ps"
echo "  2. After deploying backend with OLLAMA_ENABLED=true:"
echo "       curl -s http://127.0.0.1:8200/health/detailed | jq '.providers.ollama'"
echo "  3. Phased rollout: see docs/runbooks/ollama-local-llm.md"
echo "  4. Operational rollback to 27B:"
echo "       sed -i 's/^OLLAMA_MODEL=.*/OLLAMA_MODEL=${ROLLBACK_MODEL}/' .env"
echo "       sed -i 's/^OLLAMA_CLASSIFIER_MODEL=.*/OLLAMA_CLASSIFIER_MODEL=${ROLLBACK_MODEL}/' .env"
echo "       pm2 restart nexus-hub"
