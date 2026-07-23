#!/usr/bin/env bash
# Boot, smoke, and stop an exact restored Nexus release without exposing a
# listener or inheriting production credentials. The process runs in private
# network/mount/PID namespaces, from an empty environment, as a dedicated
# unprivileged account. Host filesystems are read-only or shadowed; only the
# verified scratch release tree and private tmpfs mounts remain writable.
set -euo pipefail
umask 077

PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

ACTION="${1:-}"
RUNTIME="${2:-}"
RUN_ROOT=/run/nexus-application-drill
SELF="$(realpath -e -- "${BASH_SOURCE[0]}")"

die() { echo "application DR isolated harness: $*" >&2; exit 1; }

canonical_directory() {
  local path="$1" label="$2"
  [[ "$path" == /* && "$path" != / && -d "$path" && ! -L "$path" ]] \
    || die "$label must be an absolute non-symlink directory"
  [ "$(realpath -e -- "$path")" = "$path" ] || die "$label must not traverse symlinks"
}

canonical_executable() {
  local path="$1" label="$2" resolved mode
  [[ "$path" == /* && -x "$path" ]] || die "$label must be an absolute executable"
  resolved="$(realpath -e -- "$path")"
  [ -f "$resolved" ] || die "$label must resolve to a regular file"
  [ "$(stat -c '%U' -- "$resolved")" = root ] || die "$label must resolve to a root-owned file"
  mode="$(stat -c '%a' -- "$resolved")"
  (( (8#$mode & 0022) == 0 )) || die "$label must not be group/world writable"
}

[ "$(id -u)" -eq 0 ] || die "must run as root"
[[ "${NEXUS_DRILL_MODE:-}" = isolated-restore ]] || die "isolated drill mode is required"
canonical_directory "$RUNTIME" "restored runtime"
[ "$RUNTIME" = "${NEXUS_DRILL_ROOT:-}" ] || die "restored runtime does not match NEXUS_DRILL_ROOT"
[[ "${NEXUS_DRILL_DATABASE_PATH:-}" = "$RUNTIME/data/bot.db"
   && -f "$NEXUS_DRILL_DATABASE_PATH" && ! -L "$NEXUS_DRILL_DATABASE_PATH" ]] \
  || die "isolated restored database path is invalid"
[ "$(realpath -e -- "$NEXUS_DRILL_DATABASE_PATH")" = "$NEXUS_DRILL_DATABASE_PATH" ] \
  || die "isolated restored database must not traverse symlinks"
[[ "${NEXUS_DRILL_BASE_URL:-}" =~ ^http://127\.0\.0\.1:([0-9]{4,5})$ ]] \
  || die "isolated loopback URL is invalid"
DRILL_PORT="${BASH_REMATCH[1]}"
(( DRILL_PORT >= 1024 && DRILL_PORT <= 65535 )) || die "isolated loopback port is invalid"
CONTENT_PORT=$((DRILL_PORT == 65535 ? 65534 : DRILL_PORT + 1))

STATE_DIR="${NEXUS_DRILL_STATE_DIR:-}"
canonical_directory "$STATE_DIR" "DR state directory"
[ "$(stat -c '%U:%G:%a' -- "$STATE_DIR")" = root:root:700 ] \
  || die "DR state directory must be root:root mode 0700"
case "$RUNTIME" in
  "$STATE_DIR"/tmp/restore-drill.*/runtime) ;;
  *) die "restored runtime must be below the private DR scratch namespace" ;;
esac

DRILL_USER="${NEXUS_DRILL_USER:-}"
[[ "$DRILL_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "dedicated drill user is invalid"
IFS=: read -r account _ DRILL_UID DRILL_GID _ _ account_shell < <(getent passwd "$DRILL_USER")
[[ "$account" = "$DRILL_USER" && "$DRILL_UID" =~ ^[0-9]+$ && "$DRILL_GID" =~ ^[0-9]+$
   && "$DRILL_UID" -gt 0 ]] || die "dedicated drill user does not exist or is privileged"
case "$account_shell" in
  /usr/sbin/nologin|/sbin/nologin|/bin/false) ;;
  *) die "dedicated drill user must have a disabled login shell" ;;
esac

NODE_BIN="${NEXUS_DRILL_NODE_BIN:-}"
canonical_executable "$NODE_BIN" "drill Node binary"
PYTHON_BIN="${NEXUS_DRILL_PYTHON_BIN:-}"
canonical_executable "$PYTHON_BIN" "drill Python binary"
CONTENT_PYTHON_BIN="$RUNTIME/content-engine/.venv/bin/python3.12"
[[ -x "$CONTENT_PYTHON_BIN" && ! -d "$CONTENT_PYTHON_BIN" ]] \
  || die "restored Content Engine virtualenv interpreter is unavailable"
content_python_resolved="$(realpath -e -- "$CONTENT_PYTHON_BIN")"
case "$content_python_resolved" in
  "$RUNTIME"/content-engine/.venv/*|"$(realpath -e -- "$PYTHON_BIN")") ;;
  *) die "restored Content Engine interpreter escapes the exact runtime and governed Python binary" ;;
esac
for command in curl env find getent grep ip mount nsenter od ps setsid setpriv sha256sum sleep ss tail tr unshare; do
  command -v "$command" >/dev/null 2>&1 || die "$command is required"
done

RUNTIME_ID="$(printf '%s' "$RUNTIME" | sha256sum | awk '{print $1}')"
[[ "$RUNTIME_ID" =~ ^[0-9a-f]{64}$ ]] || die "runtime identity is invalid"
PROCESS_STATE="$RUN_ROOT/state-$RUNTIME_ID"
MOUNTPOINT="$RUN_ROOT/runtime-$RUNTIME_ID"
PID_FILE="$PROCESS_STATE/supervisor.pid"
TOKEN_FILE="$PROCESS_STATE/read-token"
RUNTIME_FILE="$PROCESS_STATE/runtime"
LOG_FILE="$PROCESS_STATE/runtime.log"
EXPECTED_USER_COUNT_FILE="$PROCESS_STATE/expected-user-count"

read_pid() {
  local pid
  [ -f "$PID_FILE" ] && [ ! -L "$PID_FILE" ] || return 1
  pid="$(cat "$PID_FILE")"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  printf '%s' "$pid"
}

recorded_process_is_live() {
  local pid="$1" command_line
  [ -d "/proc/$pid" ] || return 1
  command_line="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)"
  [[ "$command_line" == *"$SELF"* && "$command_line" == *"__namespace"* && "$command_line" == *"$RUNTIME"* ]]
}

namespace_curl() {
  local pid="$1"
  shift
  nsenter --target "$pid" --net -- curl "$@"
}

namespace_main() {
  local token
  token="$(cat "$TOKEN_FILE")"
  [[ "$token" =~ ^[0-9a-f]{64}$ ]] || die "isolated drill credential evidence is invalid"

  mount --make-rprivate /
  mount --bind "$RUNTIME" "$MOUNTPOINT"
  mount -o remount,bind,rw "$MOUNTPOINT"
  mount -t tmpfs -o mode=0755,nosuid,nodev,noexec,size=1m tmpfs /home
  mount -t tmpfs -o mode=0700,nosuid,nodev,noexec,size=1m tmpfs /root
  mount -t tmpfs -o mode=1777,nosuid,nodev,size=64m tmpfs /tmp
  mount -t tmpfs -o mode=1777,nosuid,nodev,size=16m tmpfs /var/tmp
  mount -o remount,ro /
  ip link set lo up
  mkdir -p "$MOUNTPOINT/.home"
  chown "$DRILL_UID:$DRILL_GID" "$MOUNTPOINT/.home"
  chmod 0700 "$MOUNTPOINT/.home"
  cd "$MOUNTPOINT"

  exec setpriv \
    --reuid "$DRILL_UID" \
    --regid "$DRILL_GID" \
    --clear-groups \
    --bounding-set=-all \
    --inh-caps=-all \
    --ambient-caps=-all \
    --no-new-privs \
    env -i \
      PATH=/usr/local/bin:/usr/bin:/bin \
      HOME="$MOUNTPOINT/.home" \
      NODE_ENV=development \
      ENV=production \
      STAGING=false \
      NEXUS_APPLICATION_DRILL_RUNTIME=1 \
      NEXUS_APPLICATION_DRILL_ROOT="$MOUNTPOINT" \
      NEXUS_BACKGROUND_JOBS_ENABLED=0 \
      NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 \
      DATABASE_PATH="$MOUNTPOINT/data/bot.db" \
      PORTAL_ENABLED=true \
      PORTAL_BIND=127.0.0.1 \
      PORTAL_PORT="$DRILL_PORT" \
      PORTAL_ALLOW_LOCAL_BYPASS=false \
      PORTAL_ALLOW_LEGACY_FALLBACK=false \
      PORTAL_REQUIRE_SESSION_AUTH=false \
      PORTAL_READ_TOKEN="$token" \
      HEALTH_TOKEN="$token" \
      HEALTH_ALLOW_UNAUTHENTICATED=false \
      INTERNAL_API_SECRET="$token" \
      CONTENT_ENGINE_ENABLED=true \
      CONTENT_ENGINE_BASE_URL="http://127.0.0.1:$CONTENT_PORT" \
      CONTENT_ENGINE_PORT="$CONTENT_PORT" \
      CONTENT_ENGINE_FIXTURE_MODE=1 \
      CONTENT_ENGINE_RESEARCH_NETWORK_DISABLED=1 \
      NEXUS_BACKEND_BASE_URL="http://127.0.0.1:$DRILL_PORT" \
      NEXUS_BACKEND_PORT="$DRILL_PORT" \
      OLLAMA_ENABLED=false \
      ANTHROPIC_ENABLED=false \
      IOS_API_ENABLED=false \
      IOS_WS_ENABLED=false \
      WEBHOOKS_ENABLED=false \
      BACKUP_ENABLED=false \
      TELEGRAM_LEGACY_DELIVERY=false \
      TELEGRAM_BOT_TOKEN=application-drill-disabled \
      NOTIFICATION_DELIVERY_MODE=mock \
      PAYWALL_ENABLED=true \
      FINANCE_ENCRYPTION_ENABLED=false \
      /usr/bin/bash -c '
        set -euo pipefail
        runtime="$1"
        node_bin="$2"
        content_python="$3"
        backend_pid=""
        content_pid=""
        shutdown() {
          local status="$1"
          trap - EXIT TERM INT
          [ -n "$backend_pid" ] && kill -TERM "$backend_pid" 2>/dev/null || true
          [ -n "$content_pid" ] && kill -TERM "$content_pid" 2>/dev/null || true
          [ -n "$backend_pid" ] && wait "$backend_pid" 2>/dev/null || true
          [ -n "$content_pid" ] && wait "$content_pid" 2>/dev/null || true
          exit "$status"
        }
        trap "shutdown 143" TERM
        trap "shutdown 130" INT
        (
          cd "$runtime/content-engine"
          exec "$content_python" main.py
        ) &
        content_pid=$!
        (
          cd "$runtime"
          exec "$node_bin" dist/index.js
        ) &
        backend_pid=$!
        set +e
        wait -n "$backend_pid" "$content_pid"
        status=$?
        set -e
        shutdown "$status"
      ' nexus-application-drill-supervisor \
        "$MOUNTPOINT" "$NODE_BIN" "$MOUNTPOINT/content-engine/.venv/bin/python3.12"
}

stop_runtime() {
  local pid pgid deadline
  pid="$(read_pid 2>/dev/null || true)"
  if [ -n "$pid" ] && recorded_process_is_live "$pid"; then
    pgid="$(ps -o pgid= -p "$pid" | tr -d ' ')"
    [ "$pgid" = "$pid" ] || die "recorded drill supervisor is not its own process group"
    kill -TERM -- "-$pid" 2>/dev/null || true
    deadline=$((SECONDS + 20))
    while recorded_process_is_live "$pid" && (( SECONDS < deadline )); do sleep 1; done
    if recorded_process_is_live "$pid"; then
      kill -KILL -- "-$pid" 2>/dev/null || true
      sleep 1
    fi
    recorded_process_is_live "$pid" && die "isolated drill process group did not stop"
  elif [ -n "$pid" ] && [ -d "/proc/$pid" ]; then
    die "recorded PID no longer identifies the isolated drill process"
  fi
  rm -rf -- "$PROCESS_STATE" "$MOUNTPOINT"
}

case "$ACTION" in
  __namespace)
    [ $# -eq 2 ] || die "invalid internal namespace invocation"
    namespace_main
    ;;
  boot)
    [ $# -eq 2 ] || die "boot accepts only the restored runtime"
    [ -d "$RUNTIME/node_modules" ] || die "offline Node dependencies are not installed"
    [ -f "$RUNTIME/.network-independent-install.json" ] \
      || die "network-independent dependency evidence is missing"
    [ ! -e "$PROCESS_STATE" ] || die "isolated drill state already exists"
    install -d -o root -g root -m 0711 "$RUN_ROOT"
    install -d -o root -g root -m 0700 "$PROCESS_STATE"
    install -d -o root -g "$DRILL_GID" -m 0710 "$MOUNTPOINT"
    printf '%s\n' "$RUNTIME" >"$RUNTIME_FILE"
    chmod 0600 "$RUNTIME_FILE"
    token="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
    [[ "$token" =~ ^[0-9a-f]{64}$ ]] || die "could not generate an ephemeral drill credential"
    printf '%s\n' "$token" >"$TOKEN_FILE"
    chmod 0600 "$TOKEN_FILE"
    "$PYTHON_BIN" - "$NEXUS_DRILL_DATABASE_PATH" >"$EXPECTED_USER_COUNT_FILE" <<'PY'
import sqlite3
import sys

database_path = sys.argv[1]
connection = sqlite3.connect(f"file:{database_path}?mode=ro", uri=True)
try:
    row = connection.execute("SELECT COUNT(*) FROM users").fetchone()
finally:
    connection.close()
if row is None or not isinstance(row[0], int) or row[0] < 0:
    raise SystemExit("restored database users table could not be read")
print(row[0])
PY
    [[ "$(cat "$EXPECTED_USER_COUNT_FILE")" =~ ^[0-9]+$ ]] \
      || die "restored database user-count evidence is invalid"
    chmod 0600 "$EXPECTED_USER_COUNT_FILE"

    # The exact restored tree is temporary and contains no production secret
    # files. Give only the dedicated nologin account access before dropping
    # every capability inside the namespace.
    chown -R "$DRILL_UID:$DRILL_GID" "$RUNTIME"
    find "$RUNTIME" -xdev -type d -exec chmod u+rwx,go-rwx {} +
    find "$RUNTIME" -xdev -type f -exec chmod u+rw,go-rwx {} +

    setsid unshare --mount --net --pid --fork --mount-proc \
      "$SELF" __namespace "$RUNTIME" >"$LOG_FILE" 2>&1 &
    pid=$!
    printf '%s\n' "$pid" >"$PID_FILE"
    chmod 0600 "$PID_FILE" "$LOG_FILE"

    deadline=$((SECONDS + 120))
    while (( SECONDS < deadline )); do
      if ! recorded_process_is_live "$pid"; then
        tail -n 40 "$LOG_FILE" >&2 || true
        stop_runtime
        die "isolated drill process exited before health readiness"
      fi
      if namespace_curl "$pid" --fail --silent --show-error --max-time 2 \
          "$NEXUS_DRILL_BASE_URL/health" >/dev/null 2>&1 \
        && namespace_curl "$pid" --fail --silent --show-error --max-time 2 \
          "http://127.0.0.1:$CONTENT_PORT/health" >/dev/null 2>&1; then
        break
      fi
      sleep 1
    done
    if ! namespace_curl "$pid" --fail --silent --show-error --max-time 2 \
        "$NEXUS_DRILL_BASE_URL/health" >/dev/null 2>&1; then
      tail -n 40 "$LOG_FILE" >&2 || true
      stop_runtime
      die "isolated drill health did not become ready"
    fi
    if ! namespace_curl "$pid" --fail --silent --show-error --max-time 2 \
        "http://127.0.0.1:$CONTENT_PORT/health" >/dev/null 2>&1; then
      tail -n 40 "$LOG_FILE" >&2 || true
      stop_runtime
      die "isolated Content Engine health did not become ready"
    fi
    if ss -ltnH "sport = :$DRILL_PORT" | grep -q .; then
      stop_runtime
      die "drill listener escaped its private network namespace"
    fi
    if ss -ltnH "sport = :$CONTENT_PORT" | grep -q .; then
      stop_runtime
      die "Content Engine drill listener escaped its private network namespace"
    fi
    ;;
  smoke)
    [ $# -eq 2 ] || die "smoke accepts only the restored runtime"
    pid="$(read_pid)" || die "isolated drill PID evidence is missing"
    recorded_process_is_live "$pid" || die "isolated drill process is not live"
    [ "$(cat "$RUNTIME_FILE")" = "$RUNTIME" ] || die "isolated drill runtime evidence changed"
    token="$(cat "$TOKEN_FILE")"
    [[ "$token" =~ ^[0-9a-f]{64}$ ]] || die "isolated drill credential evidence is invalid"
    if ss -ltnH "sport = :$DRILL_PORT" | grep -q .; then
      die "drill listener is visible in the host network namespace"
    fi
    if ss -ltnH "sport = :$CONTENT_PORT" | grep -q .; then
      die "Content Engine drill listener is visible in the host network namespace"
    fi

    invalid_status="$(namespace_curl "$pid" --silent --show-error --max-time 5 \
      --output "$PROCESS_STATE/invalid-auth.json" --write-out '%{http_code}' \
      --header 'Authorization: Bearer invalid-drill-token' \
      "$NEXUS_DRILL_BASE_URL/api/snapshot")"
    [ "$invalid_status" = 401 ] || die "invalid drill credential was not rejected"

    namespace_curl "$pid" --fail --silent --show-error --max-time 5 \
      --header "Authorization: Bearer $token" \
      "$NEXUS_DRILL_BASE_URL/health/detailed" >"$PROCESS_STATE/health.json"
    namespace_curl "$pid" --fail --silent --show-error --max-time 5 \
      --header "Authorization: Bearer $token" \
      "$NEXUS_DRILL_BASE_URL/api/snapshot" >"$PROCESS_STATE/snapshot.json"
    namespace_curl "$pid" --fail --silent --show-error --max-time 5 \
      --header "Authorization: Bearer $token" \
      "$NEXUS_DRILL_BASE_URL/api/usage/summary" >"$PROCESS_STATE/representative-read.json"
    namespace_curl "$pid" --fail --silent --show-error --max-time 5 \
      "http://127.0.0.1:$CONTENT_PORT/health" >"$PROCESS_STATE/content-health.json"
    namespace_curl "$pid" --fail --silent --show-error --max-time 5 \
      --header "x-internal-secret: $token" \
      "http://127.0.0.1:$CONTENT_PORT/ready" >"$PROCESS_STATE/content-ready.json"
    nsenter --target "$pid" --pid --mount -- ps -eo pid=,args= \
      >"$PROCESS_STATE/processes.txt"

    "$PYTHON_BIN" - \
      "$PROCESS_STATE/health.json" "$PROCESS_STATE/snapshot.json" \
      "$PROCESS_STATE/representative-read.json" "$EXPECTED_USER_COUNT_FILE" \
      "$PROCESS_STATE/content-health.json" "$PROCESS_STATE/content-ready.json" \
      "$PROCESS_STATE/processes.txt" "$NODE_BIN" \
      "$MOUNTPOINT/content-engine/.venv/bin/python3.12" \
      "$RUNTIME/dist/index.js" "$RUNTIME/content-engine/main.py" <<'PY'
import hashlib
import json
import sys

health = json.load(open(sys.argv[1], encoding="utf-8"))
snapshot = json.load(open(sys.argv[2], encoding="utf-8"))
representative = json.load(open(sys.argv[3], encoding="utf-8"))
with open(sys.argv[4], encoding="utf-8") as source:
    expected_user_count = int(source.read().strip())
content_health = json.load(open(sys.argv[5], encoding="utf-8"))
content_ready = json.load(open(sys.argv[6], encoding="utf-8"))
with open(sys.argv[7], encoding="utf-8") as source:
    process_rows = source.read().splitlines()
node_command = f"{sys.argv[8]} dist/index.js"
content_command = f"{sys.argv[9]} main.py"
node_runtime_path = sys.argv[10]
content_runtime_path = sys.argv[11]
if (
    health.get("status") != "healthy"
    or health.get("database") != "connected"
    or health.get("server", {}).get("status") != "online"
    or health.get("server", {}).get("database") != "connected"
):
    raise SystemExit("authenticated detailed health did not prove the restored database")
if not isinstance(snapshot.get("version"), str) or not snapshot["version"]:
    raise SystemExit("authenticated snapshot has no version")
if not isinstance(snapshot.get("uptime"), (int, float)):
    raise SystemExit("authenticated snapshot has no uptime")
if (
    representative.get("ok") is not True
    or not isinstance(representative.get("totalUsers"), int)
    or representative["totalUsers"] != expected_user_count
    or not isinstance(representative.get("sparkline"), list)
    or len(representative["sparkline"]) != 7
):
    raise SystemExit("authenticated representative database read is invalid")
if content_health.get("status") != "ok" or not isinstance(content_health.get("version"), str):
    raise SystemExit("restored Content Engine health is invalid")
if (
    content_ready.get("status") != "ready"
    or content_ready.get("internalAuthConfigured") is not True
    or not isinstance(content_ready.get("routers"), list)
    or not content_ready["routers"]
):
    raise SystemExit("restored Content Engine readiness is invalid")

def matching_processes(expected):
    matches = []
    for row in process_rows:
        fields = row.strip().split(maxsplit=1)
        if len(fields) == 2 and fields[0].isdigit() and fields[1] == expected:
            matches.append(int(fields[0]))
    return matches

node_processes = matching_processes(node_command)
content_processes = matching_processes(content_command)
if len(node_processes) != 1 or len(content_processes) != 1:
    raise SystemExit("isolated drill did not prove exactly one backend and Content Engine process")
if node_processes[0] == content_processes[0]:
    raise SystemExit("isolated drill process identities are not distinct")

def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

print(json.dumps({
    "schemaVersion": "NexusApplicationDrillSmokeV1",
    "status": "passed",
    "nodeBackendHealthVerified": True,
    "contentEngineHealthVerified": True,
    "contentEngineReadinessVerified": True,
    "processIdentities": {
        "nodeBackend": {
            "pidNamespaceProcessId": node_processes[0],
            "runtimePath": "dist/index.js",
            "runtimeSha256": sha256(node_runtime_path),
        },
        "contentEngine": {
            "pidNamespaceProcessId": content_processes[0],
            "runtimePath": "content-engine/main.py",
            "runtimeSha256": sha256(content_runtime_path),
        },
    },
}, separators=(",", ":")))
PY
    ;;
  stop)
    [ $# -eq 2 ] || die "stop accepts only the restored runtime"
    stop_runtime
    ;;
  *)
    die "expected boot, smoke, or stop"
    ;;
esac
