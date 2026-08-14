#!/usr/bin/env bash
# scripts/install-ollama.sh
# ----------------------------------------------------------------------------
# Install and configure Ollama as a loopback-only systemd service for the
# active digest-pinned model in the signed Nexus local-model manifest.
#
# Idempotent: safe to re-run. The resource envelope is fixed and rejects all
# environment overrides. Only non-envelope installer behavior remains tunable.
#
# Operator notes:
#   - Loopback-only bind (OLLAMA_HOST=127.0.0.1:11434). Never expose to LAN/WAN.
#   - The active manifest model must already match its reviewed exact digest.
#   - MemoryHigh applies soft pressure (kernel reclaims pages) before MemoryMax
#     hard-kills. MemorySwapMax limits runaway swap thrash on a CPU-only host.
#   - Operational rollback disables Ollama and uses the existing approved cloud
#     route; this installer never pulls a model or changes the signed selection.
# ----------------------------------------------------------------------------
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# ── Helpers ─────────────────────────────────────────────────────────────────
log() { printf '\n→ %s\n' "$*"; }
fail() { printf '\nFAIL: %s\n' "$*" >&2; exit "${2:-1}"; }

fsync_path() {
  /usr/bin/env node - "$1" <<'NODE'
const fs = require('node:fs');
const descriptor = fs.openSync(process.argv[2], 'r');
try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
NODE
}

validate_root_directory() {
  local path="$1" label="$2" expected_mode="${3:-}" mode owner
  [ -d "$path" ] && [ ! -L "$path" ] \
    && [ "$(realpath -e -- "$path")" = "$path" ] \
    || fail "$label is not a canonical non-symlink directory"
  owner="$(stat -c '%U:%G' -- "$path")"
  mode="$(stat -c '%a' -- "$path")"
  [ "$owner" = root:root ] || fail "$label is not root-owned"
  (( (8#$mode & 0022) == 0 )) || fail "$label is group/world writable"
  [ -z "$expected_mode" ] || [ "$mode" = "$expected_mode" ] \
    || fail "$label must have mode $expected_mode"
}

ensure_root_directory() {
  local path="$1" label="$2" mode="$3" parent
  if [ -L "$path" ]; then
    fail "$label is a symlink"
  elif [ ! -e "$path" ]; then
    parent="$(dirname -- "$path")"
    validate_root_directory "$parent" "$label parent"
    mkdir -- "$path"
    chown root:root "$path"
    chmod "$mode" "$path"
    fsync_path "$path"
    fsync_path "$parent"
  fi
  validate_root_directory "$path" "$label" "$mode"
}

validate_root_path_chain() {
  local path="$1" label="$2" current owner mode
  [[ "$path" == /* && "$path" != / && ! -L "$path" ]] \
    || fail "$label must be an absolute non-symlink path"
  [ "$(realpath -e -- "$path")" = "$path" ] \
    || fail "$label must not traverse symlinks"
  current="$path"
  while :; do
    owner="$(stat -c '%U:%G' -- "$current")"
    mode="$(stat -c '%a' -- "$current")"
    [ "$owner" = root:root ] || fail "$label path component is not root-owned: $current"
    (( (8#$mode & 0022) == 0 )) \
      || fail "$label path component is group/world writable: $current"
    [ "$current" = / ] && break
    current="$(dirname -- "$current")"
  done
}

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

readonly OLLAMA_CONTEXT_LENGTH="16384"
readonly OLLAMA_MAX_QUEUE="4"
readonly OLLAMA_NUM_PARALLEL="1"
readonly OLLAMA_MAX_LOADED_MODELS="1"
readonly OLLAMA_MEMORY_HIGH="18G"
readonly OLLAMA_MEMORY_MAX="20G"
readonly OLLAMA_MEMORY_SWAP_MAX="0"
readonly OLLAMA_CPU_QUOTA="800%"

# ── Non-envelope installer tunables ─────────────────────────────────────────
REQUIRED_FREE_GB="${REQUIRED_FREE_GB:-8}"
OLLAMA_BINARY=/usr/local/bin/ollama
OLLAMA_BINARY_SHA256="b2e45ade9cb754a079f74645e1183d613f582d98f7354b05f4f9a5bd81f8e0c9"
OLLAMA_VERSION_OUTPUT="ollama version is 0.24.0"
OLLAMA_SERVICE_FRAGMENT=/etc/systemd/system/ollama.service
OLLAMA_SERVICE_FRAGMENT_SHA256="72b23db27bcd69aa9c05226285a928ae8520dac108736072a33cea35bbcccdda"
OLLAMA_LOAD_TIMEOUT="${OLLAMA_LOAD_TIMEOUT:-5m}"
OLLAMA_NICE="${OLLAMA_NICE:-10}"
OLLAMA_CPUWEIGHT="${OLLAMA_CPUWEIGHT:-25}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [ "${1:-}" = "--verify-envelope-only" ] && [ "$#" -eq 1 ]; then
  printf '{"contextLength":16384,"maxQueue":4,"numParallel":1,"maxLoadedModels":1,"memoryHigh":"18G","memoryMax":"20G","cpuQuota":"800%%","memorySwapMax":"0"}\n'
  exit 0
fi
[ "$#" -eq 4 ] || fail \
  "usage: sudo install-ollama.sh <root-owned-source-root> <40-hex-source-sha> <root-owned-source-archive> <64-hex-archive-sha256>" \
  64
SOURCE_ROOT="$1"
SOURCE_SHA="$2"
SOURCE_ARCHIVE="$3"
EXPECTED_ARCHIVE_SHA256="$4"
BOOTSTRAP_BASE=/var/lib/nexus-release-bootstrap
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] \
  || fail "source SHA must be exactly 40 lowercase hexadecimal characters" 64
[[ "$EXPECTED_ARCHIVE_SHA256" =~ ^[0-9a-f]{64}$ ]] \
  || fail "archive SHA-256 must be exactly 64 lowercase hexadecimal characters" 64
EXPECTED_BOOTSTRAP_ROOT="$BOOTSTRAP_BASE/$SOURCE_SHA"
[ "$SOURCE_ROOT" = "$EXPECTED_BOOTSTRAP_ROOT/source" ] \
  || fail "source root must be the exact SHA-bound bootstrap source path" 64
[ "$SOURCE_ARCHIVE" = "$EXPECTED_BOOTSTRAP_ROOT/source.tar.gz" ] \
  || fail "source archive must be the exact SHA-bound bootstrap archive path" 64
[ "$SCRIPT_DIR" = "$SOURCE_ROOT/scripts" ] \
  || fail "installer must execute from the exact reviewed bootstrap source path" 77
[[ "${BASH_SOURCE[0]}" == /* && ! -L "${BASH_SOURCE[0]}" ]] \
  && [ "$(realpath -e -- "${BASH_SOURCE[0]}")" = "$SOURCE_ROOT/scripts/install-ollama.sh" ] \
  || fail "installer executable identity differs from the reviewed bootstrap source" 77

# ── Pre-flight ──────────────────────────────────────────────────────────────
[ "$EUID" -eq 0 ] \
  || fail "run the reviewed installer as root (sudo bash scripts/install-ollama.sh)" 77
for required_command in curl flock install mktemp mv node python3 realpath sha256sum stat systemctl; do
  command -v "$required_command" >/dev/null 2>&1 \
    || fail "$required_command is required for transactional Ollama installation"
done
validate_root_path_chain "$SCRIPT_DIR" "reviewed Ollama installer source"
validate_root_path_chain "$SOURCE_ROOT" "reviewed Ollama bootstrap source"
validate_root_path_chain "$SOURCE_ARCHIVE" "reviewed Ollama bootstrap archive"
reviewed_assets=(
  scripts/install-ollama.sh
  scripts/ollama-lean-finalize.mjs
  scripts/ollama-service-envelope-check.mjs
  scripts/lib/ollama-service-envelope.mjs
  scripts/ollama-systemd-dropin-transaction.mjs
  scripts/ollama-install-state-check.mjs
  scripts/local-inference-socket-transaction.mjs
  scripts/local-model-benchmark-envelope-transaction.mjs
  scripts/systemd/00-nexus-ollama-install-guard.conf
  scripts/systemd/nexus-local-inference-sockets.conf
  config/local-model-manifest.json
)
for reviewed_asset in "${reviewed_assets[@]}"; do
  validate_root_path_chain "$SOURCE_ROOT/$reviewed_asset" "reviewed Ollama asset ($reviewed_asset)"
done
archive_sha256="$(sha256sum -- "$SOURCE_ARCHIVE" | cut -d' ' -f1)"
[ "$archive_sha256" = "$EXPECTED_ARCHIVE_SHA256" ] \
  || fail "bootstrap source archive digest does not match the owner-approved digest" 77
# Prove the reviewed archive commit and exact operational source members.
python3 - "$SOURCE_ARCHIVE" "$SOURCE_ROOT" "$SOURCE_SHA" "${reviewed_assets[@]}" <<'PY'
import hashlib
import os
import pathlib
import sys
import tarfile

archive_path, source_root, source_sha, *assets = sys.argv[1:]
source_root_path = pathlib.Path(source_root)
required = set(assets)
with tarfile.open(archive_path, mode="r:*") as archive:
    if archive.pax_headers.get("comment") != source_sha:
        raise SystemExit("Ollama install archive verifier: Git archive commit does not match source SHA")
    expected_names = {f"source/{relative}": relative for relative in required}
    members = {}
    for member in archive.getmembers():
        relative = expected_names.get(member.name)
        if relative is None:
            continue
        if relative in members:
            raise SystemExit(f"Ollama install archive verifier: duplicate member {member.name}")
        if not member.isreg() or member.issym() or member.islnk():
            raise SystemExit(f"Ollama install archive verifier: required member is not regular: {member.name}")
        if relative in {
            "scripts/ollama-systemd-dropin-transaction.mjs",
            "scripts/local-inference-socket-transaction.mjs",
            "scripts/local-model-benchmark-envelope-transaction.mjs",
        } and not (member.mode & 0o111):
            raise SystemExit(f"Ollama install archive verifier: transaction helper is not executable: {relative}")
        members[relative] = member
    missing = sorted(required - members.keys())
    if missing:
        raise SystemExit(f"Ollama install archive verifier: missing required member {missing[0]}")
    for relative in sorted(required):
        member = members[relative]
        extracted = archive.extractfile(member)
        if extracted is None:
            raise SystemExit(f"Ollama install archive verifier: cannot read {member.name}")
        archive_digest = hashlib.sha256(extracted.read()).hexdigest()
        local_path = source_root_path / relative
        if not local_path.is_file() or local_path.is_symlink():
            raise SystemExit(f"Ollama install archive verifier: unsafe source {relative}")
        if relative in {
            "scripts/ollama-systemd-dropin-transaction.mjs",
            "scripts/local-inference-socket-transaction.mjs",
            "scripts/local-model-benchmark-envelope-transaction.mjs",
        } and not os.access(local_path, os.X_OK):
            raise SystemExit(f"Ollama install archive verifier: local transaction helper is not executable: {relative}")
        if hashlib.sha256(local_path.read_bytes()).hexdigest() != archive_digest:
            raise SystemExit(f"Ollama install archive verifier: source drift for {relative}")
PY

# The release-signed manifest is the only model-selection authority. The
# installer validates and records that exact tag/digest but never downloads it.
mapfile -t active_model_identity < <(node - "$SOURCE_ROOT/config/local-model-manifest.json" <<'NODE'
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const active = Array.isArray(manifest.models)
  ? manifest.models.find((model) => model?.id === manifest.activeModelId)
  : null;
const winners = Array.isArray(manifest.models)
  ? manifest.models.filter((model) => model?.role === 'winner')
  : [];
const digest = String(active?.digest || '');
const evidence = manifest.selectionEvidence;
const productionEvidenceValid = manifest.selectionStatus !== 'production_selected' || (
  evidence && typeof evidence === 'object' && !Array.isArray(evidence)
  && evidence.winningCandidateId === manifest.activeModelId
  && /^sha256:[0-9a-f]{64}$/u.test(evidence.benchmarkReportDigest || '')
  && typeof evidence.benchmarkCompletedAt === 'string'
  && !Number.isNaN(Date.parse(evidence.benchmarkCompletedAt))
  && new Date(evidence.benchmarkCompletedAt).toISOString() === evidence.benchmarkCompletedAt
  && /^sha256:[0-9a-f]{64}$/u.test(evidence.benchmarkHostRollbackReceiptDigest || '')
  && [
    'corpusReference',
    'licenseReviewReference',
    'ownerApprovalReference',
  ]
    .every((field) => typeof evidence[field] === 'string'
      && evidence[field].trim().length > 0
      && evidence[field].trim().length <= 512)
);
const selectionValid = manifest.schemaVersion === 'nexus.local-model-manifest.v1'
  && ['control_only', 'production_selected'].includes(manifest.selectionStatus)
  && (manifest.selectionStatus !== 'control_only' || manifest.selectionEvidence === null)
  && (manifest.selectionStatus === 'control_only'
    ? winners.length === 0
    : winners.length === 1 && winners[0]?.id === active?.id)
  && productionEvidenceValid
  && active?.productionEligible === true
  && active?.evidenceStatus === 'verified'
  && typeof active?.ollamaTag === 'string'
  && active.ollamaTag.length > 0
  && /^sha256:[0-9a-f]{64}$/u.test(digest)
  && (manifest.selectionStatus !== 'production_selected' || active.role === 'winner');
if (!selectionValid) process.exit(2);
process.stdout.write(`${active.ollamaTag}\n${digest.slice('sha256:'.length)}\n`);
NODE
)
[ "${#active_model_identity[@]}" -eq 2 ] \
  || fail "signed local-model manifest has no verified digest-pinned active model" 77
readonly PRIMARY_MODEL="${active_model_identity[0]}"
readonly RETAINED_MODEL_DIGEST="${active_model_identity[1]}"
unset active_model_identity
validate_root_path_chain "$OLLAMA_BINARY" "reviewed Ollama binary"
[ -f "$OLLAMA_BINARY" ] && [ ! -L "$OLLAMA_BINARY" ] \
  && [ "$(stat -c '%U:%G:%a' -- "$OLLAMA_BINARY")" = root:root:755 ] \
  || fail "reviewed Ollama binary ownership or mode changed" 77
[ "$(sha256sum -- "$OLLAMA_BINARY" | cut -d' ' -f1)" = "$OLLAMA_BINARY_SHA256" ] \
  || fail "reviewed Ollama binary digest changed" 77
[ "$("$OLLAMA_BINARY" --version 2>&1)" = "$OLLAMA_VERSION_OUTPUT" ] \
  || fail "reviewed Ollama binary version changed" 77
validate_root_path_chain "$OLLAMA_SERVICE_FRAGMENT" "reviewed Ollama service fragment"
[ -f "$OLLAMA_SERVICE_FRAGMENT" ] && [ ! -L "$OLLAMA_SERVICE_FRAGMENT" ] \
  && [ "$(stat -c '%U:%G:%a' -- "$OLLAMA_SERVICE_FRAGMENT")" = root:root:644 ] \
  || fail "reviewed Ollama service fragment ownership or mode changed" 77
[ "$(sha256sum -- "$OLLAMA_SERVICE_FRAGMENT" | cut -d' ' -f1)" \
    = "$OLLAMA_SERVICE_FRAGMENT_SHA256" ] \
  || fail "reviewed Ollama service fragment digest changed" 77
[ "$(systemctl show ollama.service --property=FragmentPath --value --no-pager)" \
    = "$OLLAMA_SERVICE_FRAGMENT" ] \
  || fail "ollama.service does not resolve to the reviewed fragment" 77

verify_retained_model_identity() {
  curl -fsS http://127.0.0.1:11434/api/tags \
    | node -e '
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  let value;
  try { value = JSON.parse(raw); } catch { process.exit(2); }
  const tag = process.argv[1];
  const digest = process.argv[2];
  const matches = Array.isArray(value?.models)
    ? value.models.filter((row) => row?.name === tag || row?.model === tag)
    : [];
  const actual = String(matches[0]?.digest || "").trim().toLowerCase().replace(/^sha256:/u, "");
  if (matches.length !== 1 || actual !== digest) process.exit(3);
});' "$PRIMARY_MODEL" "$RETAINED_MODEL_DIGEST" \
    || fail "retained Ollama model is absent or differs from the reviewed exact digest" 77
}

verify_retained_model_identity
log "Pre-flight: disk, memory, OS"
if [ -n "${OLLAMA_PRIMARY_MODEL:-}" ] && [ "${OLLAMA_PRIMARY_MODEL}" != "${PRIMARY_MODEL}" ]; then
  fail "signed-manifest policy rejects OLLAMA_PRIMARY_MODEL=${OLLAMA_PRIMARY_MODEL}; expected ${PRIMARY_MODEL}" 6
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

# Prevalidate every destination boundary before the transaction helper records
# exact predecessors and replaces any operational asset. The shared mutex
# keeps releases, Sonar, and Ollama finalization out of this maintenance transaction.
log "Prevalidating transactional Ollama operational assets"
validate_root_directory /usr/local/sbin "Ollama executable directory"
ensure_root_directory /usr/local/sbin/lib "Ollama executable library directory" 755
validate_root_directory /etc/systemd/system "systemd unit directory" 755
ensure_root_directory \
  /etc/systemd/system/ollama.service.d \
  "Ollama systemd drop-in directory" 755
ensure_root_directory /var/lib/nexus-release "Nexus release state directory" 755
ensure_root_directory \
  /var/lib/nexus-release/ollama-install \
  "Ollama install state directory" 700

shared_mutex=/run/lock/nexus-release-sonar.lock
[ -f "$shared_mutex" ] && [ ! -L "$shared_mutex" ] \
  && [ "$(stat -c '%U:%G:%a' -- "$shared_mutex")" = root:dominguez:660 ] \
  || fail "shared release/Sonar/Ollama mutex is missing or unsafe" 75
exec 8<>"$shared_mutex"
flock -n 8 || fail "release, Sonar, or Ollama finalization is active" 75

install_lock=/var/lib/nexus-release/ollama-install/.install.lock
if [ -L "$install_lock" ]; then
  fail "Ollama installation lock is a symlink"
elif [ ! -e "$install_lock" ]; then
  install -o root -g root -m 0600 /dev/null "$install_lock"
  fsync_path "$install_lock"
  fsync_path "$(dirname -- "$install_lock")"
else
  [ -f "$install_lock" ] \
    && [ "$(stat -c '%U:%G:%a' -- "$install_lock")" = root:root:600 ] \
    || fail "Ollama installation lock is unsafe"
fi
exec 9<>"$install_lock"
flock -n 9 || fail "another Ollama installation transaction is active" 75
if [ -L /var/run/reboot-required ]; then
  fail "pending-reboot marker is a symlink" 75
elif [ -e /var/run/reboot-required ]; then
  fail "complete the pending maintenance reboot before installing Ollama" 75
fi

# The permanent guard is installed by the reviewed promotion/Sonar bootstrap.
# It must already be exact before the journal can exist, so a reboot or daemon
# restart in the journal-to-candidate window still fails closed.
installed_state_checker=/usr/local/sbin/nexus-ollama-install-state-check.mjs
installed_install_guard=/etc/systemd/system/ollama.service.d/00-nexus-ollama-install-guard.conf
[ -f "$installed_state_checker" ] && [ ! -L "$installed_state_checker" ] \
  && [ "$(stat -c '%U:%G:%a' -- "$installed_state_checker")" = root:root:700 ] \
  && [ "$(sha256sum -- "$installed_state_checker" | cut -d' ' -f1)" \
    = "$(sha256sum -- "$SCRIPT_DIR/ollama-install-state-check.mjs" | cut -d' ' -f1)" ] \
  || fail "reviewed permanent Ollama install-state checker is not bootstrapped" 77
[ -f "$installed_install_guard" ] && [ ! -L "$installed_install_guard" ] \
  && [ "$(stat -c '%U:%G:%a' -- "$installed_install_guard")" = root:root:644 ] \
  && [ "$(sha256sum -- "$installed_install_guard" | cut -d' ' -f1)" \
    = "$(sha256sum -- "$SCRIPT_DIR/systemd/00-nexus-ollama-install-guard.conf" | cut -d' ' -f1)" ] \
  || fail "reviewed permanent Ollama install guard is not bootstrapped" 77
validate_root_path_chain "$installed_state_checker" "installed Ollama install-state checker"
validate_root_path_chain "$installed_install_guard" "installed Ollama install guard"
systemctl daemon-reload
[ "$(systemctl show ollama.service --property=NeedDaemonReload --value --no-pager)" = no ] \
  || fail "systemd did not load the permanent Ollama install guard" 77

# ── Existing governed runtime identity ──────────────────────────────────────
log "Using preinstalled reviewed Ollama runtime: ${OLLAMA_VERSION_OUTPUT}"
[ "$(command -v ollama)" = "$OLLAMA_BINARY" ] \
  || fail "PATH does not resolve ollama to the reviewed binary" 77
[ -d /var/lib/ollama/models ] && [ ! -L /var/lib/ollama/models ] \
  && [ "$(realpath -e -- /var/lib/ollama/models)" = /var/lib/ollama/models ] \
  && [ "$(stat -c '%U:%G' -- /var/lib/ollama/models)" = ollama:ollama ] \
  && (( (8#$(stat -c '%a' -- /var/lib/ollama/models) & 0022) == 0 )) \
  || fail "existing Ollama model directory is unsafe; refusing to change ownership" 77

# ── systemd override ────────────────────────────────────────────────────────
drop_in_dir=/etc/systemd/system/ollama.service.d
drop_in_path="$drop_in_dir/override.conf"
transaction_helper="$SCRIPT_DIR/ollama-systemd-dropin-transaction.mjs"
transaction_candidate="$(mktemp -p /var/lib/nexus-release/ollama-install ".override.candidate.XXXXXX")"
chmod 0600 "$transaction_candidate"
transaction_journal=/var/lib/nexus-release/ollama-install/install-in-progress.v1.json
transaction_active=false
transaction_cleanup() {
  local status=$?
  rm -f -- "${transaction_candidate:-}" || true
  if [ "$transaction_active" = true ]; then
    if [ -L "$transaction_journal" ]; then
      printf '\nFAIL: Ollama rollback journal is a symlink; it remains fail-closed for root investigation\n' >&2
    elif [ -e "$transaction_journal" ]; then
      if ! "$transaction_helper" rollback --reason installer_exit_"$status" >/dev/null; then
        printf '\nFAIL: Ollama rollback could not be proven; the durable install journal remains and future restarts fail closed\n' >&2
      else
        printf '\n→ Resolved the durable Ollama transaction to its exact terminal or predecessor state\n' >&2
      fi
    fi
  fi
  return "$status"
}
trap transaction_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

log "Staging transactional systemd override (${drop_in_path})"
cat >"$transaction_candidate" <<EOF
[Service]
# ── Ollama daemon env ─────────────────────────────────────────────────────
# Loopback only — never expose Ollama on a public interface.
Environment="OLLAMA_HOST=127.0.0.1:11434"
Environment="OLLAMA_MODELS=/var/lib/ollama/models"

# Concurrency: single-model, CPU-only, daemon-side serialization.
Environment="OLLAMA_MAX_LOADED_MODELS=${OLLAMA_MAX_LOADED_MODELS}"
Environment="OLLAMA_NUM_PARALLEL=${OLLAMA_NUM_PARALLEL}"
Environment="OLLAMA_MAX_QUEUE=${OLLAMA_MAX_QUEUE}"

# Context + KV cache are bounded by the production manifest envelope.
Environment="OLLAMA_CONTEXT_LENGTH=${OLLAMA_CONTEXT_LENGTH}"
Environment="OLLAMA_KV_CACHE_TYPE=q8_0"
Environment="OLLAMA_FLASH_ATTENTION=1"

# Keep the sole manifest-selected model warm; the cgroup memory ceiling remains hard.
Environment="OLLAMA_KEEP_ALIVE=-1"

# Bounded cold-load timeout for the single resident model.
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
fsync_path "$transaction_candidate"

log "Replacing the systemd drop-in under a durable rollback journal"
transaction_active=true
"$transaction_helper" begin \
  --candidate "$transaction_candidate" \
  --installer-pid "$$" \
  --source-root "$SOURCE_ROOT" \
  --source-sha "$SOURCE_SHA" \
  --archive-sha256 "$EXPECTED_ARCHIVE_SHA256" \
  --ollama-binary "$OLLAMA_BINARY" \
  --ollama-binary-sha256 "$OLLAMA_BINARY_SHA256" \
  --ollama-version "$OLLAMA_VERSION_OUTPUT" \
  --service-fragment "$OLLAMA_SERVICE_FRAGMENT" \
  --service-fragment-sha256 "$OLLAMA_SERVICE_FRAGMENT_SHA256" \
  --retained-model "$PRIMARY_MODEL" \
  --retained-model-digest "$RETAINED_MODEL_DIGEST" >/dev/null

log "Reloading systemd + enabling/restarting ollama.service"
systemctl daemon-reload
"$transaction_helper" authorize-restart --installer-pid "$$" >/dev/null
systemctl enable --now ollama
systemctl restart ollama

log "Verifying effective fixed systemd envelope"
/usr/bin/env node "/usr/local/sbin/nexus-ollama-service-envelope-check.mjs" --expected-swap-bytes 0 \
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

# ── Warm-load + smoke ───────────────────────────────────────────────────────
log "Warm-load + smoke (think:false, num_predict=16)"
"$OLLAMA_BINARY" list
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

log "Re-verifying exact binary, service fragment, and retained model identities"
[ "$(sha256sum -- "$OLLAMA_BINARY" | cut -d' ' -f1)" = "$OLLAMA_BINARY_SHA256" ] \
  && [ "$("$OLLAMA_BINARY" --version 2>&1)" = "$OLLAMA_VERSION_OUTPUT" ] \
  || fail "reviewed Ollama binary changed during installation" 77
[ "$(sha256sum -- "$OLLAMA_SERVICE_FRAGMENT" | cut -d' ' -f1)" \
    = "$OLLAMA_SERVICE_FRAGMENT_SHA256" ] \
  || fail "Ollama service fragment changed during installation" 77
verify_retained_model_identity

log "Committing the validated Ollama systemd transaction"
"$transaction_helper" commit >/dev/null
transaction_active=false
rm -f -- "$transaction_candidate"
transaction_candidate=""

# ── Done ────────────────────────────────────────────────────────────────────
log "Install complete"
echo "  daemon:    127.0.0.1:11434 (loopback only)"
echo "  model:     ${PRIMARY_MODEL} (signed manifest)"
echo "  systemd:   MemoryHigh=${OLLAMA_MEMORY_HIGH} MemoryMax=${OLLAMA_MEMORY_MAX} MemorySwapMax=${OLLAMA_MEMORY_SWAP_MAX} CPUQuota=${OLLAMA_CPU_QUOTA} CPUWeight=${OLLAMA_CPUWEIGHT} Nice=${OLLAMA_NICE}"
echo
echo "Next steps (operator):"
echo "  1. Verify in browser: curl -s http://127.0.0.1:11434/api/ps"
echo "  2. Run /usr/local/sbin/nexus-local-model-benchmark-envelope-transaction.mjs plan --candidate-id <signed-manifest-id>; apply the same candidate ID and receipt-rollback each controlled benchmark window."
echo "  3. After signing the winner, rerun this installer from that exact settled protected-main release to install its manifest/model identity."
echo "  4. Then run /usr/local/sbin/nexus-local-inference-socket-transaction.mjs plan and inspect its owner acknowledgement digest."
echo "  5. Apply that exact socket plan only in the attended host transaction; signed Compose remains unchanged until its receipt exists."
echo "  6. The legacy lean finalizer is control-model cleanup only; do not run it"
echo "     for a production-selected winner."
echo "  7. Operational rollback: set local inference mode off;"
echo "     approved Gemini/cloud routing remains available."
