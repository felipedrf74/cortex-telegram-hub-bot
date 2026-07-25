#!/usr/bin/env bash
# Root-owned wrapper for the advisory Compose stack. It never installs Docker,
# updates images, prunes volumes, or exposes container environment values.
set -euo pipefail
umask 077

ACTION="${1:-}"
STACK_DIR="${SONAR_STACK_DIR:-/srv/sonarqube}"
SECRETS_FILE="${SONAR_SECRETS_FILE:-/etc/sonarqube/sonarqube.env}"
COMPOSE_FILE="$STACK_DIR/compose.yaml"
LOCK_FILE="$STACK_DIR/images.lock.env"
PREFLIGHT_POINTER="${SONAR_PREFLIGHT_POINTER:-/etc/sonarqube/preflight-evidence.path}"
OLLAMA_SOAK_POINTER="${SONAR_OLLAMA_SOAK_POINTER:-/etc/sonarqube/ollama-soak-evidence.path}"
OLLAMA_CLEANUP_POINTER="${SONAR_OLLAMA_CLEANUP_POINTER:-/etc/sonarqube/ollama-cleanup-result.path}"
BACKUP_CONFIG="${SONAR_BACKUP_CONFIG:-/etc/sonarqube/backup.env}"
SHARED_MUTEX=/run/lock/nexus-release-sonar.lock
INSTALL_JOURNAL=/var/lib/nexus-sonarqube/install-in-progress.v1
DOCKER_BIN="$(command -v docker 2>/dev/null || true)"
NODE_BIN="$(command -v node 2>/dev/null || true)"
CURL_BIN="$(command -v curl 2>/dev/null || true)"
SYSTEMCTL_BIN="$(command -v systemctl 2>/dev/null || true)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() { echo "Usage: quality-sonar-stack.sh <config|start|stop|restart|status>"; }
case "$ACTION" in config|start|stop|restart|status) ;; -h|--help|'') usage; [ -n "$ACTION" ] && exit 0 || exit 64 ;; *) usage >&2; exit 64 ;; esac

[ "$(id -u)" -eq 0 ] || { echo "The Sonar stack wrapper must run as root" >&2; exit 1; }
[ ! -e "$INSTALL_JOURNAL" ] && [ ! -L "$INSTALL_JOURNAL" ] \
  || { echo "Sonar asset installation is incomplete; inspect and rerun the root installer" >&2; exit 1; }
[ -x "$DOCKER_BIN" ] || { echo "Docker Engine is not installed" >&2; exit 1; }
[ -x "$NODE_BIN" ] || { echo "Node.js is required to validate the rendered Sonar stack" >&2; exit 1; }
for path in "$COMPOSE_FILE" "$LOCK_FILE" "$SECRETS_FILE"; do
  [ -f "$path" ] && [ ! -L "$path" ] || { echo "Required non-symlink file is missing: $path" >&2; exit 1; }
done
secret_mode="$(stat -c '%a' "$SECRETS_FILE" 2>/dev/null || stat -f '%Lp' "$SECRETS_FILE")"
[ "$secret_mode" = 600 ] || { echo "Sonar secrets file must have mode 0600" >&2; exit 1; }
secret_owner="$(stat -c '%U' "$SECRETS_FILE" 2>/dev/null || stat -f '%Su' "$SECRETS_FILE")"
[ "$secret_owner" = root ] || { echo "Sonar secrets file must be owned by root" >&2; exit 1; }

resolver="$SCRIPT_DIR/quality-sonar-resolve-images.sh"
[ -x "$resolver" ] || resolver=/usr/local/sbin/quality-sonar-resolve-images
"$resolver" --verify-lock-only --lock-file "$LOCK_FILE" >/dev/null
health="$SCRIPT_DIR/quality-sonar-health.sh"
[ -x "$health" ] || health=/usr/local/sbin/quality-sonar-health
start_evidence="$SCRIPT_DIR/quality-sonar-start-evidence.mjs"
[ -x "$start_evidence" ] || start_evidence=/usr/local/sbin/quality-sonar-start-evidence.mjs
live_ollama="$SCRIPT_DIR/quality-sonar-live-ollama-state.mjs"
[ -x "$live_ollama" ] || live_ollama=/usr/local/sbin/quality-sonar-live-ollama-state
backup="$SCRIPT_DIR/quality-sonar-backup.sh"
[ -x "$backup" ] || backup=/usr/local/sbin/quality-sonar-backup

compose=("$DOCKER_BIN" compose --project-directory "$STACK_DIR" --env-file "$LOCK_FILE" --env-file "$SECRETS_FILE" -f "$COMPOSE_FILE")

read_exact_lock_value() {
  local key="$1"
  awk -F= -v key="$key" '
    $1 == key {
      count += 1
      value = substr($0, index($0, "=") + 1)
    }
    END {
      if (count != 1) exit 1
      print value
    }
  ' "$LOCK_FILE"
}

LOCKED_SONAR_IMAGE="$(read_exact_lock_value SONARQUBE_IMAGE)" \
  || { echo "Sonar image lock must contain exactly one SONARQUBE_IMAGE" >&2; exit 1; }
LOCKED_POSTGRES_IMAGE="$(read_exact_lock_value POSTGRES_IMAGE)" \
  || { echo "Sonar image lock must contain exactly one POSTGRES_IMAGE" >&2; exit 1; }
if grep -Eq '^[[:space:]]*(export[[:space:]]+)?(SONARQUBE_IMAGE|POSTGRES_IMAGE)[[:space:]]*=' "$SECRETS_FILE"; then
  echo "Sonar secrets file must not override immutable image references" >&2
  exit 1
fi

verify_prepulled_images() {
  local image
  for image in "$LOCKED_SONAR_IMAGE" "$LOCKED_POSTGRES_IMAGE"; do
    "$DOCKER_BIN" image inspect "$image" >/dev/null 2>&1 || {
      echo "Required immutable image is not pre-pulled: ${image%@*}@<reviewed-digest>" >&2
      return 1
    }
  done
}

assert_directory() {
  local path="$1" expected_owner="$2" expected_mode="$3"
  [ -d "$path" ] && [ ! -L "$path" ] || { echo "Required Sonar bind directory is missing or a symlink: $path" >&2; return 1; }
  [ "$(stat -c '%u:%g' "$path")" = "$expected_owner" ] || { echo "Unexpected Sonar bind-directory owner: $path" >&2; return 1; }
  [ "$(stat -c '%a' "$path")" = "$expected_mode" ] || { echo "Unexpected Sonar bind-directory mode: $path" >&2; return 1; }
}

validate_data_layout() {
  assert_directory /srv/sonarqube 0:0 750
  assert_directory /srv/sonarqube/data 0:0 750
  assert_directory /srv/sonarqube/data/postgresql 999:999 700
  for path in sonarqube extensions logs temp; do
    assert_directory "/srv/sonarqube/data/$path" 1000:1000 750
  done
}

read_protected_pointer() {
  local pointer="$1" label="$2" lines=()
  [ -f "$pointer" ] && [ ! -L "$pointer" ] || { echo "$label pointer is missing or a symlink: $pointer" >&2; return 1; }
  [ "$(stat -c '%U' "$pointer")" = root ] && [ "$(stat -c '%a' "$pointer")" = 600 ] || {
    echo "$label pointer must be root-owned mode 0600" >&2
    return 1
  }
  mapfile -t lines <"$pointer"
  [ "${#lines[@]}" -eq 1 ] && [[ "${lines[0]}" == /* ]] && [ "${lines[0]}" != / ] || {
    echo "$label pointer must contain exactly one safe absolute path" >&2
    return 1
  }
  printf '%s' "${lines[0]}"
}

verify_start_evidence() {
  [ -x "$start_evidence" ] || { echo "Sonar start-evidence verifier is unavailable" >&2; return 1; }
  local preflight_dir soak_evidence cleanup_result boot_id
  preflight_dir="$(read_protected_pointer "$PREFLIGHT_POINTER" 'preflight evidence')"
  soak_evidence="$(read_protected_pointer "$OLLAMA_SOAK_POINTER" 'Ollama soak evidence')"
  cleanup_result="$(read_protected_pointer "$OLLAMA_CLEANUP_POINTER" 'Ollama cleanup result')"
  boot_id="$(tr -d '\r\n' </proc/sys/kernel/random/boot_id 2>/dev/null || true)"
  [[ "$boot_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || {
    echo "Unable to read the current Linux boot ID" >&2
    return 1
  }
  "$start_evidence" verify-start \
    --preflight-directory "$preflight_dir" \
    --ollama-soak-evidence "$soak_evidence" \
    --ollama-cleanup-result "$cleanup_result" \
    --current-boot-id "$boot_id" >/dev/null
}

verify_backup_readiness() {
  [ -x "$backup" ] || { echo "Sonar backup verifier is unavailable" >&2; return 1; }
  "$backup" --config "$BACKUP_CONFIG" --verify-config >/dev/null
}

verify_live_ollama() (
  set -euo pipefail
  [ -x "$live_ollama" ] || { echo "Live Ollama verifier is unavailable" >&2; return 1; }
  [ -x "$CURL_BIN" ] || { echo "curl is required for the live Ollama verifier" >&2; return 1; }
  [ -x "$SYSTEMCTL_BIN" ] || { echo "systemctl is required for the live Ollama verifier" >&2; return 1; }
  local cleanup_result temp_dir
  cleanup_result="$(read_protected_pointer "$OLLAMA_CLEANUP_POINTER" 'Ollama cleanup result')"
  temp_dir="$(mktemp -d)"
  chmod 0700 "$temp_dir"
  trap 'rm -rf "$temp_dir"' EXIT
  "$SYSTEMCTL_BIN" show ollama.service --no-pager \
    --property=ActiveState \
    --property=Environment \
    --property=MemoryHigh \
    --property=MemoryMax \
    --property=MemorySwapMax \
    --property=CPUQuotaPerSecUSec >"$temp_dir/systemd.txt"
  "$CURL_BIN" --fail --silent --show-error --max-time 5 \
    http://127.0.0.1:11434/api/tags >"$temp_dir/tags.json"
  "$CURL_BIN" --fail --silent --show-error --max-time 5 \
    http://127.0.0.1:11434/api/ps >"$temp_dir/loaded.json"
  chmod 0600 "$temp_dir/systemd.txt" "$temp_dir/tags.json" "$temp_dir/loaded.json"
  "$live_ollama" \
    --cleanup-result "$cleanup_result" \
    --systemd-state "$temp_dir/systemd.txt" \
    --tags "$temp_dir/tags.json" \
    --loaded "$temp_dir/loaded.json" >/dev/null
)

acquire_shared_mutex() {
  command -v flock >/dev/null 2>&1 || { echo "flock is required for the shared release/Sonar mutex" >&2; return 1; }
  [ -f "$SHARED_MUTEX" ] && [ ! -L "$SHARED_MUTEX" ] || { echo "Preprovisioned shared release/Sonar mutex is missing" >&2; return 1; }
  [ "$(stat -c '%U:%G' "$SHARED_MUTEX")" = root:dominguez ] && [ "$(stat -c '%a' "$SHARED_MUTEX")" = 660 ] || {
    echo "Shared release/Sonar mutex must be root:dominguez mode 0660" >&2
    return 1
  }
  exec 8<>"$SHARED_MUTEX"
  flock -n 8 || { echo "Sonar operation refused: a release or advisory scan holds $SHARED_MUTEX" >&2; return 1; }
}

validate_config() {
  local rendered
  rendered="$(mktemp)"
  chmod 0600 "$rendered"
  if ! "${compose[@]}" config --format json >"$rendered"; then
    rm -f "$rendered"
    return 1
  fi
  if ! "$NODE_BIN" - \
      "$rendered" "$LOCKED_POSTGRES_IMAGE" "$LOCKED_SONAR_IMAGE" <<'NODE'
const fs = require('fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const lockedPostgresImage = process.argv[3];
const lockedSonarImage = process.argv[4];
const postgres = value.services?.postgres;
const sonar = value.services?.sonarqube;
if (!postgres || !sonar) throw new Error('required services are absent');
if (postgres.image !== lockedPostgresImage || sonar.image !== lockedSonarImage) {
  throw new Error('rendered service image differs from the immutable image lock');
}
if (postgres.restart !== 'no' || sonar.restart !== 'no') throw new Error('Docker restart policy must not bypass root start authorization');
if (Number(postgres.cpus) !== 1 || Number(postgres.mem_limit) !== 2 * 1024 * 1024 * 1024
    || Number(sonar.cpus) !== 2 || Number(sonar.mem_limit) !== 6 * 1024 * 1024 * 1024) {
  throw new Error('rendered CPU or memory limits differ from the approved Sonar envelope');
}
if ((postgres.ports || []).length !== 0) throw new Error('PostgreSQL must not publish a host port');
const ports = sonar.ports || [];
if (ports.length !== 1
    || ports[0].host_ip !== '127.0.0.1'
    || Number(ports[0].published) !== 9000
    || Number(ports[0].target) !== 9000) {
  throw new Error('SonarQube must publish exactly one IPv4 loopback port');
}
if (value.networks?.sonar_backend?.internal !== true) throw new Error('Sonar backend network must be internal');
const expected = new Map([
  ['/var/lib/postgresql/data', '/srv/sonarqube/data/postgresql'],
  ['/opt/sonarqube/data', '/srv/sonarqube/data/sonarqube'],
  ['/opt/sonarqube/extensions', '/srv/sonarqube/data/extensions'],
  ['/opt/sonarqube/logs', '/srv/sonarqube/data/logs'],
  ['/opt/sonarqube/temp', '/srv/sonarqube/data/temp'],
]);
const mounts = [...(postgres.volumes || []), ...(sonar.volumes || [])];
if (mounts.length !== expected.size) throw new Error('unexpected persistent mount count');
for (const mount of mounts) {
  if (mount.type !== 'bind' || expected.get(mount.target) !== mount.source
      || mount.bind?.create_host_path !== false) {
    throw new Error(`unapproved persistent mount: ${mount.target || 'unknown'}`);
  }
  expected.delete(mount.target);
}
if (expected.size !== 0) throw new Error('required host bind mount is missing');
NODE
  then
    rm -f "$rendered"
    echo "Rendered Sonar configuration violates the isolation or bind-storage contract" >&2
    return 1
  fi
  rm -f "$rendered"
  echo "sonarqube_compose_config_ok network=loopback-only database=internal"
}

verify_runtime_limits() {
  local postgres_id sonar_id temp_dir
  postgres_id="$("${compose[@]}" ps --quiet postgres)"
  sonar_id="$("${compose[@]}" ps --quiet sonarqube)"
  [[ "$postgres_id" =~ ^[a-f0-9]{12,64}$ ]] \
    && [[ "$sonar_id" =~ ^[a-f0-9]{12,64}$ ]] \
    || { echo "Unable to resolve the exact running Sonar container identities" >&2; return 1; }
  temp_dir="$(mktemp -d)"
  chmod 0700 "$temp_dir"
  if ! "$DOCKER_BIN" inspect --format '{{json .HostConfig}}' "$postgres_id" >"$temp_dir/postgres.json" \
      || ! "$DOCKER_BIN" inspect --format '{{json .HostConfig}}' "$sonar_id" >"$temp_dir/sonarqube.json"; then
    rm -rf "$temp_dir"
    echo "Unable to inspect the running Sonar resource envelope" >&2
    return 1
  fi
  chmod 0600 "$temp_dir/postgres.json" "$temp_dir/sonarqube.json"
  if ! "$NODE_BIN" - "$temp_dir/postgres.json" "$temp_dir/sonarqube.json" <<'NODE'
const fs = require('fs');
const [postgresPath, sonarPath] = process.argv.slice(2);
const postgres = JSON.parse(fs.readFileSync(postgresPath, 'utf8'));
const sonar = JSON.parse(fs.readFileSync(sonarPath, 'utf8'));
if (Number(postgres.NanoCpus) !== 1_000_000_000
    || Number(postgres.Memory) !== 2 * 1024 * 1024 * 1024
    || Number(sonar.NanoCpus) !== 2_000_000_000
    || Number(sonar.Memory) !== 6 * 1024 * 1024 * 1024) process.exit(1);
NODE
  then
    rm -rf "$temp_dir"
    echo "Running Sonar containers exceed or omit the approved CPU/RAM envelope" >&2
    return 1
  fi
  rm -rf "$temp_dir"
  echo "sonarqube_runtime_limits_ok postgresCpu=1 postgresMemoryGiB=2 sonarCpu=2 sonarMemoryGiB=6"
}

stop_stack() {
  "${compose[@]}" stop -t 3600 sonarqube postgres
  echo "sonarqube_stack_stopped bind_data=preserved"
}

start_stack() {
  verify_start_evidence
  verify_backup_readiness
  validate_data_layout
  validate_config >/dev/null
  # This is intentionally the final authorization read before Compose starts:
  # historical evidence cannot hide a reintroduced model, digest drift, or an
  # expanded effective service envelope.
  verify_live_ollama
  verify_prepulled_images
  "${compose[@]}" up -d --pull never
  if ! verify_runtime_limits; then
    "${compose[@]}" stop -t 3600 sonarqube postgres >/dev/null 2>&1 || true
    echo "Sonar runtime resource verification failed; stopped advisory containers" >&2
    return 1
  fi
  if ! "$health" --url http://127.0.0.1:9000; then
    "${compose[@]}" stop -t 3600 sonarqube postgres >/dev/null 2>&1 || true
    echo "Sonar failed startup health; stopped advisory containers" >&2
    return 1
  fi
  local listener
  listener="$(ss -ltnH 'sport = :9000' 2>/dev/null || true)"
  if [ -z "$listener" ] || printf '%s\n' "$listener" | grep -Evq '127\.0\.0\.1:9000[[:space:]]'; then
    "${compose[@]}" stop -t 3600 sonarqube postgres >/dev/null 2>&1 || true
    echo "Sonar listener verification failed or found a non-loopback bind" >&2
    return 1
  fi
  echo "sonarqube_stack_started advisory=true storage=host-bind"
}

case "$ACTION" in
  config)
    validate_config
    ;;
  start)
    acquire_shared_mutex
    start_stack
    ;;
  stop)
    acquire_shared_mutex
    stop_stack
    ;;
  restart)
    acquire_shared_mutex
    stop_stack
    start_stack
    ;;
  status)
    "$health" --url http://127.0.0.1:9000 --attempts 1 --interval 0
    "${compose[@]}" ps --status running
    ;;
esac
