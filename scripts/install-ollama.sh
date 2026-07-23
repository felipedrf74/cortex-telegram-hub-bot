#!/usr/bin/env bash
# scripts/install-ollama.sh
# ----------------------------------------------------------------------------
# Install and configure Ollama as a loopback-only systemd service for the
# single approved Nexus Hub model: qwen2.5:3b-instruct-q4_K_M.
#
# Idempotent: safe to re-run. The resource envelope is fixed and rejects all
# environment overrides. Only non-envelope installer behavior remains tunable.
#
# Operator notes:
#   - Loopback-only bind (OLLAMA_HOST=127.0.0.1:11434). Never expose to LAN/WAN.
#   - The small-only model pull is fatal. Alternate local tags are rejected.
#   - MemoryHigh applies soft pressure (kernel reclaims pages) before MemoryMax
#     hard-kills. MemorySwapMax limits runaway swap thrash on a CPU-only host.
#   - Operational rollback disables Ollama and uses the existing approved cloud
#     route; this installer never pre-pulls or selects a large local model.
# ----------------------------------------------------------------------------
set -euo pipefail

# ── Helpers ─────────────────────────────────────────────────────────────────
log() { printf '\n→ %s\n' "$*"; }
fail() { printf '\nFAIL: %s\n' "$*" >&2; exit "${2:-1}"; }

# ── Fixed resource envelope ─────────────────────────────────────────────────
# Reject inherited values even when they happen to equal the policy. This
# prevents a caller, shell profile, or automation layer from becoming an
# unreviewed second source of truth for the production host envelope.
ENVELOPE_VARIABLES=(
  OLLAMA_CONTEXT_LENGTH
  OLLAMA_MAX_QUEUE
  OLLAMA_NUM_PARALLEL
  OLLAMA_MAX_LOADED_MODELS
  OLLAMA_MEMORY_HIGH
  OLLAMA_MEMORY_MAX
  OLLAMA_MEMORY_SWAP_MAX
  OLLAMA_CPU_QUOTA
)
for envelope_variable in "${ENVELOPE_VARIABLES[@]}"; do
  if declare -p "${envelope_variable}" >/dev/null 2>&1; then
    fail "environment override is forbidden for ${envelope_variable}; the Ollama envelope is fixed" 8
  fi
done

readonly OLLAMA_CONTEXT_LENGTH="4096"
readonly OLLAMA_MAX_QUEUE="4"
readonly OLLAMA_NUM_PARALLEL="1"
readonly OLLAMA_MAX_LOADED_MODELS="1"
readonly OLLAMA_MEMORY_HIGH="4G"
readonly OLLAMA_MEMORY_MAX="6G"
readonly OLLAMA_MEMORY_SWAP_MAX="512M"
readonly OLLAMA_CPU_QUOTA="200%"

# ── Non-envelope installer tunables ─────────────────────────────────────────
REQUIRED_FREE_GB="${REQUIRED_FREE_GB:-8}"
PRIMARY_MODEL="qwen2.5:3b-instruct-q4_K_M"
OLLAMA_LOAD_TIMEOUT="${OLLAMA_LOAD_TIMEOUT:-5m}"
OLLAMA_NICE="${OLLAMA_NICE:-10}"
OLLAMA_CPUWEIGHT="${OLLAMA_CPUWEIGHT:-25}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [ "${1:-}" = "--verify-envelope-only" ] && [ "$#" -eq 1 ]; then
  printf '{"contextLength":4096,"maxQueue":4,"numParallel":1,"maxLoadedModels":1,"memoryHigh":"4G","memoryMax":"6G","cpuQuota":"200%%","memorySwapMax":"512M"}\n'
  exit 0
fi
[ "$#" -eq 0 ] || fail "unknown installer argument" 64

# ── Pre-flight ──────────────────────────────────────────────────────────────
log "Pre-flight: disk, memory, OS"
if [ -n "${OLLAMA_PRIMARY_MODEL:-}" ] && [ "${OLLAMA_PRIMARY_MODEL}" != "${PRIMARY_MODEL}" ]; then
  fail "small-only policy rejects OLLAMA_PRIMARY_MODEL=${OLLAMA_PRIMARY_MODEL}; expected ${PRIMARY_MODEL}" 6
fi
if [ -n "${OLLAMA_OPERATIONAL_ROLLBACK_MODEL:-}" ]; then
  fail "OLLAMA_OPERATIONAL_ROLLBACK_MODEL is removed; rollback by disabling Ollama" 7
fi
free_gb=$(df --output=avail -BG / | tail -1 | tr -dc '0-9')
[ "${free_gb}" -ge "${REQUIRED_FREE_GB}" ] \
  || fail "need ${REQUIRED_FREE_GB}G free on /, have ${free_gb}G" 1
total_ram_gb=$(free -g | awk '/^Mem:/ {print $2}')
echo "  disk free: ${free_gb}G · RAM total: ${total_ram_gb}G"
echo "  systemd memory: MemoryHigh=${OLLAMA_MEMORY_HIGH} MemoryMax=${OLLAMA_MEMORY_MAX} MemorySwapMax=${OLLAMA_MEMORY_SWAP_MAX}"
echo "  ollama daemon: MODEL=${PRIMARY_MODEL} NUM_PARALLEL=${OLLAMA_NUM_PARALLEL} MAX_LOADED_MODELS=${OLLAMA_MAX_LOADED_MODELS} CTX=${OLLAMA_CONTEXT_LENGTH} QUEUE=${OLLAMA_MAX_QUEUE} LOAD_TIMEOUT=${OLLAMA_LOAD_TIMEOUT}"

# The observation authority is installed root-only beside its validator. The
# collector refuses to run from the checkout or any alternate production path.
log "Installing root-owned Ollama observation collector"
sudo install -o root -g root -m 0700 \
  "${SCRIPT_DIR}/ollama-observation-collector.mjs" \
  /usr/local/sbin/nexus-ollama-observation-collector.mjs
sudo install -o root -g root -m 0700 \
  "${SCRIPT_DIR}/ollama-soak-evidence.mjs" \
  /usr/local/sbin/ollama-soak-evidence.mjs
sudo install -d -o root -g root -m 0700 \
  /var/lib/nexus-release/ollama-observations

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

# Concurrency: single-model, CPU-only, daemon-side serialization.
Environment="OLLAMA_MAX_LOADED_MODELS=${OLLAMA_MAX_LOADED_MODELS}"
Environment="OLLAMA_NUM_PARALLEL=${OLLAMA_NUM_PARALLEL}"
Environment="OLLAMA_MAX_QUEUE=${OLLAMA_MAX_QUEUE}"

# Context + KV cache are bounded for the 3B classifier/planner workload.
Environment="OLLAMA_CONTEXT_LENGTH=${OLLAMA_CONTEXT_LENGTH}"
Environment="OLLAMA_KV_CACHE_TYPE=q8_0"
Environment="OLLAMA_FLASH_ATTENTION=1"

# Keep the sole 3B model warm; the service-level memory ceiling remains hard.
Environment="OLLAMA_KEEP_ALIVE=-1"

# Bounded cold-load timeout for the 1.9 GB model.
Environment="OLLAMA_LOAD_TIMEOUT=${OLLAMA_LOAD_TIMEOUT}"

# Disable any cloud-pull behavior in Ollama (defense-in-depth; we want pulls
# to be explicit, not lazy).
Environment="OLLAMA_NO_CLOUD=1"

# Quiet request logs (we observe via Nexus Hub structured logging instead).
Environment="OLLAMA_DEBUG_LOG_REQUESTS=0"

# ── Resource isolation ────────────────────────────────────────────────────
# MemoryHigh applies soft pressure BEFORE MemoryMax kills the daemon.
# The hard limit ensures local inference cannot consume Sonar/production
# headroom even if a future Ollama version regresses.
MemoryHigh=${OLLAMA_MEMORY_HIGH}
MemoryMax=${OLLAMA_MEMORY_MAX}
MemorySwapMax=${OLLAMA_MEMORY_SWAP_MAX}

# Cooperate with nexus-hub and content-engine for CPU.
Nice=${OLLAMA_NICE}
CPUWeight=${OLLAMA_CPUWEIGHT}
CPUQuota=${OLLAMA_CPU_QUOTA}

# Restart=on-failure (NOT always) so a crash loop surfaces rather than masks.
Restart=on-failure
RestartSec=10
EOF

log "Reloading systemd + enabling/restarting ollama.service"
sudo systemctl daemon-reload
sudo systemctl enable --now ollama
sudo systemctl restart ollama

log "Verifying effective fixed systemd envelope"
node "${SCRIPT_DIR}/ollama-service-envelope-check.mjs" --expected-swap-bytes 536870912 \
  || fail "effective Ollama resource envelope differs from the fixed installation policy" 9

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

# ── Pull the sole approved model (FATAL on failure) ────────────────────────
log "Pulling small-only model: ${PRIMARY_MODEL} (fatal on failure)"
if ! ollama pull "${PRIMARY_MODEL}" 2>&1 | tee /tmp/ollama-pull-primary.log; then
  fail "small-only model pull failed — see /tmp/ollama-pull-primary.log; no alternate local tag is permitted" 2
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
echo "  model:     ${PRIMARY_MODEL} (small-only)"
echo "  systemd:   MemoryHigh=${OLLAMA_MEMORY_HIGH} MemoryMax=${OLLAMA_MEMORY_MAX} MemorySwapMax=${OLLAMA_MEMORY_SWAP_MAX} CPUQuota=${OLLAMA_CPU_QUOTA} CPUWeight=${OLLAMA_CPUWEIGHT} Nice=${OLLAMA_NICE}"
echo
echo "Next steps (operator):"
echo "  1. Verify in browser: curl -s http://127.0.0.1:11434/api/ps"
echo "  2. Run scripts/staging-smoke-ollama.sh with HEALTH_TOKEN configured."
echo "  3. Operational rollback: set OLLAMA_ENABLED=false and restart Nexus Hub;"
echo "     approved Gemini/cloud routing remains available."
