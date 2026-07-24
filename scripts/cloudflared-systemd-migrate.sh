#!/usr/bin/env bash
# Two-phase, token-free migration from the legacy ServerDominguez cron child to
# a root-owned systemd connector. The old connector is never stopped until the
# new replica has active HA connections and serves the confirmed public route.
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"

SERVICE=nexus-cloudflared.service
METRICS_URL=http://127.0.0.1:20243/metrics
PUBLIC_HEALTH_URL=https://api.nexushub.me/health
STATE_DIR=/var/lib/nexus-cloudflared
STATE_PATH="$STATE_DIR/migration.json"
LOCK_PATH=/run/lock/nexus-cloudflared-migration.lock
CONFIG_TARGET=/etc/nexus-cloudflared/config.yml
CREDENTIAL_TARGET=/etc/nexus-cloudflared/tunnel.json
BINARY_TARGET=/usr/local/bin/cloudflared
UNIT_TARGET=/etc/systemd/system/nexus-cloudflared.service
UNIT_RELATIVE=ops/cloudflared/systemd/nexus-cloudflared.service

mode=
source_root=
binary_source=
config_source=
credential_source=
binary_digest=
config_digest=
credential_digest=
unit_digest=
legacy_pid=
legacy_user=dominguez
legacy_exe_digest=
legacy_broker_started=false
legacy_broker_fds_open=false
legacy_broker_retired=false
legacy_broker_pid=
legacy_broker_dir=

die() {
  printf 'cloudflared migration: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage:
  scripts/cloudflared-systemd-migrate.sh --verify-inputs-only \
    --binary <file> --binary-sha256 <sha256> \
    --config <file> --config-sha256 <sha256> \
    --credential <file> --credential-sha256 <sha256>

  sudo scripts/cloudflared-systemd-migrate.sh --install-replica \
    --source-root <root-owned-tree> \
    --binary <root-owned-file> --binary-sha256 <sha256> \
    --config <root-owned-file> --config-sha256 <sha256> \
    --credential <root-owned-file> --credential-sha256 <sha256> \
    --legacy-pid <pid> --legacy-user dominguez \
    --legacy-exe-sha256 <sha256>

  sudo scripts/cloudflared-systemd-migrate.sh --retire-legacy

No mode accepts a tunnel token. Prepare the locally managed tunnel config and
credential JSON in a root-owned mode-0600 staging directory. After
--install-replica succeeds, securely remove every cloudflared line from the
legacy user's crontab before --retire-legacy.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --verify-inputs-only|--install-replica|--retire-legacy)
      [ -z "$mode" ] || die "exactly one mode is required"
      mode="${1#--}"
      shift
      ;;
    --source-root|--binary|--binary-sha256|--config|--config-sha256|\
    --credential|--credential-sha256|--legacy-pid|--legacy-user|\
    --legacy-exe-sha256)
      [ "$#" -ge 2 ] || die "an option value is missing"
      case "$1" in
        --source-root) source_root="$2" ;;
        --binary) binary_source="$2" ;;
        --binary-sha256) binary_digest="$2" ;;
        --config) config_source="$2" ;;
        --config-sha256) config_digest="$2" ;;
        --credential) credential_source="$2" ;;
        --credential-sha256) credential_digest="$2" ;;
        --legacy-pid) legacy_pid="$2" ;;
        --legacy-user) legacy_user="$2" ;;
        --legacy-exe-sha256) legacy_exe_digest="$2" ;;
      esac
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unsupported option"
      ;;
  esac
done

[ -n "$mode" ] || {
  usage >&2
  exit 64
}

for secret_name in TUNNEL_TOKEN CF_TUNNEL_TOKEN CLOUDFLARE_TUNNEL_TOKEN; do
  [ -z "${!secret_name:-}" ] || die "token-bearing environment is forbidden"
done

require_digest() {
  [[ "$1" =~ ^[0-9a-f]{64}$ ]] || die "$2 must be a lowercase SHA-256"
}

validate_file() {
  python3 - "$1" "$2" "$3" <<'PY'
import os
import stat
import sys

path, kind, require_root = sys.argv[1], sys.argv[2], sys.argv[3] == "root"
if not os.path.isabs(path):
    raise SystemExit(1)
try:
    observed = os.lstat(path)
except OSError:
    raise SystemExit(1)
if not stat.S_ISREG(observed.st_mode) or observed.st_nlink != 1:
    raise SystemExit(1)
if os.path.realpath(path) != path:
    raise SystemExit(1)
if observed.st_mode & 0o022:
    raise SystemExit(1)
if kind in {"config", "credential", "state"} and observed.st_mode & 0o077:
    raise SystemExit(1)
if require_root:
    current = path
    while True:
        item = os.lstat(current)
        if item.st_uid != 0 or item.st_mode & 0o022:
            raise SystemExit(1)
        if current == "/":
            break
        current = os.path.dirname(current)
PY
}

file_digest() {
  python3 - "$1" <<'PY'
import hashlib
import sys
value = hashlib.sha256()
with open(sys.argv[1], "rb") as handle:
    for block in iter(lambda: handle.read(1024 * 1024), b""):
        value.update(block)
print(value.hexdigest())
PY
}

validate_config_and_credential() {
  python3 - "$config_source" "$credential_source" <<'PY'
import json
import re
import sys

config_path, credential_path = sys.argv[1:3]
config_bytes = open(config_path, "rb").read(131073)
credential_bytes = open(credential_path, "rb").read(65537)
if len(config_bytes) > 131072 or len(credential_bytes) > 65536:
    raise SystemExit(1)
config = config_bytes.decode("utf-8", "strict")
if "\x00" in config or "\t" in config:
    raise SystemExit(1)
if re.search(r"(?im)^\s*(?:token|password|secret)\s*:", config):
    raise SystemExit(1)
tunnels = re.findall(
    r"(?m)^tunnel:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$",
    config,
)
paths = re.findall(r"(?m)^credentials-file:\s*(\S+)\s*$", config)
hostnames = re.findall(r"(?m)^\s*-\s+hostname:\s*(\S+)\s*$", config)
if len(tunnels) != 1 or paths != [
    "/run/credentials/nexus-cloudflared.service/tunnel.json"
] or hostnames != ["api.nexushub.me"]:
    raise SystemExit(1)
try:
    credential = json.loads(credential_bytes)
except Exception:
    raise SystemExit(1)
if not isinstance(credential, dict):
    raise SystemExit(1)
if set(credential) != {"AccountTag", "TunnelID", "TunnelSecret"}:
    raise SystemExit(1)
if credential.get("TunnelID") != tunnels[0]:
    raise SystemExit(1)
if not all(
    isinstance(credential.get(key), str) and credential[key]
    for key in ("AccountTag", "TunnelID", "TunnelSecret")
):
    raise SystemExit(1)
PY
}

validate_ingress() {
  local private_output url hostname service
  private_output="$(mktemp)"
  if ! "$binary_source" --version >"$private_output" 2>&1; then
    rm -f -- "$private_output"
    die "cloudflared binary did not execute"
  fi
  if ! "$binary_source" --config "$config_source" tunnel ingress validate \
    >"$private_output" 2>&1; then
    rm -f -- "$private_output"
    die "cloudflared rejected the ingress configuration"
  fi
  while IFS=$'\t' read -r url hostname service; do
    if ! "$binary_source" --config "$config_source" tunnel ingress rule "$url" \
      >"$private_output" 2>&1 \
      || ! grep -Fq -- "hostname: $hostname" "$private_output" \
      || ! grep -Fq -- "service: $service" "$private_output"; then
      rm -f -- "$private_output"
      die "cloudflared ingress routing does not match the canonical loopback contract"
    fi
  done <<'ROUTES'
https://api.nexushub.me/health	api.nexushub.me	http://127.0.0.1:8200
ROUTES
  rm -f -- "$private_output"
}

validate_inputs() {
  local ownership="$1"
  [ -n "$binary_source" ] && [ -n "$config_source" ] \
    && [ -n "$credential_source" ] || die "binary, config, and credential are required"
  require_digest "$binary_digest" "binary digest"
  require_digest "$config_digest" "config digest"
  require_digest "$credential_digest" "credential digest"
  validate_file "$binary_source" binary "$ownership" \
    || die "binary source is unsafe"
  validate_file "$config_source" config "$ownership" \
    || die "config source is unsafe"
  validate_file "$credential_source" credential "$ownership" \
    || die "credential source is unsafe"
  [ "$(file_digest "$binary_source")" = "$binary_digest" ] \
    || die "binary digest mismatch"
  [ "$(file_digest "$config_source")" = "$config_digest" ] \
    || die "config digest mismatch"
  [ "$(file_digest "$credential_source")" = "$credential_digest" ] \
    || die "credential digest mismatch"
  validate_config_and_credential \
    || die "config and credential identities do not match"
  validate_ingress
}

if [ "$mode" = verify-inputs-only ]; then
  validate_inputs user
  printf '{"ok":true,"mode":"verify-inputs-only","tokenMaterialEmitted":false}\n'
  exit 0
fi

[ "$(id -u)" -eq 0 ] || die "mutation modes must run as root"
for command in awk cat chmod chown cmp curl dirname flock grep id install \
  mkfifo mktemp mv python3 readlink realpath rm rmdir sleep systemctl; do
  command -v "$command" >/dev/null 2>&1 || die "$command is required"
done
exec 9>"$LOCK_PATH"
flock -n 9 || die "another cloudflared migration is active"

validate_legacy() {
  local pid="$1" user="$2" expected_digest="$3" uid observed_uid comm exe
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || die "legacy PID is invalid"
  [[ "$user" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "legacy user is invalid"
  require_digest "$expected_digest" "legacy executable digest"
  [ -r "/proc/$pid/stat" ] && [ -r "/proc/$pid/status" ] \
    || die "legacy connector process is absent"
  comm="$(cat "/proc/$pid/comm")"
  [ "$comm" = cloudflared ] || die "legacy PID is not cloudflared"
  uid="$(id -u "$user")"
  observed_uid="$(awk '/^Uid:/{print $2; exit}' "/proc/$pid/status")"
  [ "$observed_uid" = "$uid" ] || die "legacy connector user mismatch"
  exe="$(readlink "/proc/$pid/exe")"
  case "$exe" in *' (deleted)') ;; *) die "legacy executable is not the expected deleted image" ;; esac
  [ "$(file_digest "/proc/$pid/exe")" = "$expected_digest" ] \
    || die "legacy executable digest mismatch"
}

legacy_starttime() {
  awk '{print $22}' "/proc/$1/stat"
}

write_state() {
  local phase="$1" starttime="$2"
  install -d -o root -g root -m 0700 "$STATE_DIR"
  python3 - "$STATE_PATH" "$phase" "$legacy_pid" "$legacy_user" "$starttime" \
    "$legacy_exe_digest" "$binary_digest" "$config_digest" "$credential_digest" \
    "$unit_digest" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

(
    target,
    phase,
    pid,
    user,
    starttime,
    legacy_digest,
    binary_digest,
    config_digest,
    credential_digest,
    unit_digest,
) = sys.argv[1:]
now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
value = {
    "schema": "nexus.cloudflared-systemd-migration.v1",
    "phase": phase,
    "legacy": {
        "pid": int(pid),
        "user": user,
        "starttimeTicks": starttime,
        "executableSha256": legacy_digest,
    },
    "installed": {
        "binarySha256": binary_digest,
        "configSha256": config_digest,
        "credentialSha256": credential_digest,
        "unitSha256": unit_digest,
        "service": "nexus-cloudflared.service",
        "metricsEndpoint": "http://127.0.0.1:20243/metrics",
        "publicProbe": "https://api.nexushub.me/health",
    },
    "updatedAt": now,
}
directory = os.path.dirname(target)
import tempfile
fd, temporary = tempfile.mkstemp(prefix=".migration.json.", dir=directory)
os.fchmod(fd, 0o600)
try:
    with os.fdopen(fd, "w") as handle:
        json.dump(value, handle, separators=(",", ":"))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, target)
    directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
except BaseException:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
    raise
PY
}

install_exact() {
  local source="$1" target="$2" mode_value="$3" parent temporary
  parent="$(dirname -- "$target")"
  if [ ! -d "$parent" ]; then
    [ "$parent" = /etc/nexus-cloudflared ] \
      || die "install target parent is missing"
    install -d -o root -g root -m 0700 "$parent"
  fi
  python3 - "$parent" <<'PY'
import os
import stat
import sys
current = sys.argv[1]
while True:
    item = os.lstat(current)
    if not stat.S_ISDIR(item.st_mode) or stat.S_ISLNK(item.st_mode):
        raise SystemExit(1)
    if item.st_uid != 0 or item.st_mode & 0o022:
        raise SystemExit(1)
    if current == "/":
        break
    current = os.path.dirname(current)
PY
  if [ -e "$target" ] || [ -L "$target" ]; then
    validate_file "$target" installed root \
      || die "existing install target is unsafe"
    [ -f "$target" ] && [ ! -L "$target" ] && cmp -s -- "$source" "$target" \
      || die "existing install target differs from the reviewed input"
    chown root:root "$target"
    chmod "$mode_value" "$target"
    return
  fi
  temporary="$(mktemp "$parent/.nexus-cloudflared.XXXXXX")"
  install -o root -g root -m "$mode_value" "$source" "$temporary"
  python3 - "$temporary" "$parent" <<'PY'
import os
import sys
for path in sys.argv[1:]:
    descriptor = os.open(path, os.O_RDONLY | (os.O_DIRECTORY if os.path.isdir(path) else 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
PY
  mv -n -- "$temporary" "$target"
  [ ! -e "$temporary" ] || die "install target appeared concurrently"
  python3 - "$parent" <<'PY'
import os
import sys
descriptor = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

connector_main_pid() {
  systemctl show "$SERVICE" -p MainPID --value
}

verify_systemd_unit_contract() {
  local fragment dropins
  fragment="$(systemctl show "$SERVICE" -p FragmentPath --value)"
  dropins="$(systemctl show "$SERVICE" -p DropInPaths --value)"
  [ "$fragment" = "$UNIT_TARGET" ] \
    && [ -z "$dropins" ] \
    && [ "$(file_digest "$UNIT_TARGET")" = "$unit_digest" ] \
    || die "new connector systemd unit identity mismatch"
}

verify_new_connector() {
  local pid private_metrics connections code attempt
  systemctl is-active --quiet "$SERVICE" || die "new connector service is not active"
  verify_systemd_unit_contract
  pid="$(connector_main_pid)"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] && [ -r "/proc/$pid/comm" ] \
    && [ "$(cat "/proc/$pid/comm")" = cloudflared ] \
    || die "new connector process identity is invalid"
  [ "$(file_digest "/proc/$pid/exe")" = "$binary_digest" ] \
    || die "new connector live executable identity mismatch"
  private_metrics="$(mktemp)"
  connections=0
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS --max-time 5 "$METRICS_URL" >"$private_metrics"; then
      connections="$(awk '
        $1 ~ /^cloudflared_tunnel_ha_connections(\{|$)/ { total += $NF }
        END { printf "%d", total + 0 }
      ' "$private_metrics")"
      [ "$connections" -gt 0 ] && break
    fi
    sleep 2
  done
  rm -f -- "$private_metrics"
  [ "$connections" -gt 0 ] || die "new connector has no active HA connections"
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$PUBLIC_HEALTH_URL")" \
    || die "public health probe failed"
  [ "$code" = 200 ] || die "public health did not return 200"
}

read_state() {
  validate_file "$STATE_PATH" state root || die "migration state is unsafe"
  python3 - "$STATE_PATH" <<'PY'
import json
import sys
value = json.load(open(sys.argv[1], encoding="utf-8"))
if value.get("schema") != "nexus.cloudflared-systemd-migration.v1":
    raise SystemExit(1)
legacy = value.get("legacy", {})
installed = value.get("installed", {})
fields = [
    value.get("phase"),
    legacy.get("pid"),
    legacy.get("user"),
    legacy.get("starttimeTicks"),
    legacy.get("executableSha256"),
    installed.get("binarySha256"),
    installed.get("configSha256"),
    installed.get("credentialSha256"),
    installed.get("unitSha256"),
]
if not all(isinstance(field, (str, int)) for field in fields):
    raise SystemExit(1)
print("\t".join(map(str, fields)))
PY
}

assert_no_cloudflared_cron_sources() {
  # Exit 0 only after every Ubuntu cron command source was read and found
  # clean. Exit 10 means a launch reference exists; every inspection error is
  # exit 20. File contents and matching lines are intentionally never emitted.
  local inspector="$SCRIPT_DIR/cloudflared-cron-source-inspector.py"
  validate_file "$inspector" helper root || return 20
  python3 "$inspector"
}

legacy_broker_command() {
  local command="$1" expected="$2" timeout="$3" response
  [ "$legacy_broker_started" = true ] \
    && [ "$legacy_broker_fds_open" = true ] || return 1
  printf '%s\n' "$command" >&7 || return 1
  IFS= read -r -t "$timeout" response <&8 || return 1
  [ "$response" = "$expected" ]
}

cleanup_legacy_broker() {
  if [ "$legacy_broker_started" = true ]; then
    if [ "$legacy_broker_retired" != true ] \
      && [ "$legacy_broker_fds_open" = true ]; then
      legacy_broker_command CONT_EXIT OK:CONT_EXIT 10 || true
    fi
    if [ "$legacy_broker_fds_open" = true ]; then
      exec 7>&-
      exec 8>&-
      legacy_broker_fds_open=false
    fi
    wait "$legacy_broker_pid" 2>/dev/null || true
    rm -f -- "$legacy_broker_dir/commands" "$legacy_broker_dir/responses"
    rmdir -- "$legacy_broker_dir" 2>/dev/null || true
    legacy_broker_started=false
  fi
}

abort_legacy_handoff() {
  local status="$1"
  trap - HUP INT TERM
  cleanup_legacy_broker
  trap - EXIT
  exit "$status"
}

start_legacy_pidfd_broker() {
  local expected_uid ready
  expected_uid="$(id -u "$legacy_user")"
  legacy_broker_dir="$(mktemp -d "$STATE_DIR/.pidfd.XXXXXX")"
  chmod 0700 "$legacy_broker_dir"
  mkfifo -m 0600 "$legacy_broker_dir/commands" "$legacy_broker_dir/responses"

  python3 - "$legacy_pid" "$expected_uid" "$recorded_starttime" \
    "$legacy_exe_digest" "$legacy_broker_dir/commands" \
    "$legacy_broker_dir/responses" <<'PY' >/dev/null 2>&1 &
import hashlib
import os
import select
import signal
import sys
import time

pid = int(sys.argv[1])
expected_uid = int(sys.argv[2])
expected_starttime = sys.argv[3]
expected_digest = sys.argv[4]
command_path = sys.argv[5]
response_path = sys.argv[6]
pidfd = None
stopped = False
responses = None


def ignore_signal(_signum, _frame):
    return None


for signal_name in ("SIGHUP", "SIGINT", "SIGTERM"):
    signal.signal(getattr(signal, signal_name), ignore_signal)


def fifo_timeout(_signum, _frame):
    raise TimeoutError("FIFO peer did not connect")


signal.signal(signal.SIGALRM, fifo_timeout)
signal.alarm(15)


def emit(value):
    responses.write(value + "\n")
    responses.flush()


def pidfd_exited(timeout_ms=0):
    return bool(poller.poll(timeout_ms))


def read_starttime():
    with open(f"/proc/{pid}/stat", "rb") as handle:
        raw = handle.read()
    marker = raw.rfind(b") ")
    if marker < 0:
        raise RuntimeError("invalid proc stat")
    fields = raw[marker + 2:].split()
    if len(fields) <= 19:
        raise RuntimeError("short proc stat")
    return fields[19].decode("ascii", "strict")


def read_real_uid():
    with open(f"/proc/{pid}/status", encoding="ascii") as handle:
        for line in handle:
            if line.startswith("Uid:"):
                return int(line.split()[1])
    raise RuntimeError("missing process uid")


def read_state():
    with open(f"/proc/{pid}/status", encoding="ascii") as handle:
        for line in handle:
            if line.startswith("State:"):
                return line.split()[1]
    raise RuntimeError("missing process state")


def executable_digest():
    value = hashlib.sha256()
    descriptor = os.open(
        f"/proc/{pid}/exe",
        os.O_RDONLY | os.O_CLOEXEC,
    )
    try:
        while True:
            block = os.read(descriptor, 1024 * 1024)
            if not block:
                break
            value.update(block)
    finally:
        os.close(descriptor)
    return value.hexdigest()


def validate_held_identity():
    if pidfd_exited():
        raise ProcessLookupError(pid)
    with open(f"/proc/{pid}/comm", encoding="ascii") as handle:
        if handle.read().strip() != "cloudflared":
            raise RuntimeError("process name mismatch")
    executable = os.readlink(f"/proc/{pid}/exe")
    if not executable.endswith(" (deleted)"):
        raise RuntimeError("legacy executable is not deleted")
    if read_real_uid() != expected_uid:
        raise RuntimeError("process uid mismatch")
    if read_starttime() != expected_starttime:
        raise RuntimeError("process start time mismatch")
    if executable_digest() != expected_digest:
        raise RuntimeError("process executable mismatch")
    # If the pidfd is still live after the /proc reads, the numeric PID could
    # not have been reused while those reads were taken.
    if pidfd_exited():
        raise ProcessLookupError(pid)


try:
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise RuntimeError("pidfd support unavailable")
    pidfd = os.pidfd_open(pid, 0)
    poller = select.poll()
    poller.register(pidfd, select.POLLIN)
    validate_held_identity()
    commands = open(command_path, encoding="ascii")
    responses = open(response_path, "w", encoding="ascii", buffering=1)
    signal.alarm(0)
    emit("READY")

    for raw_command in commands:
        command = raw_command.strip()
        if command == "STOP":
            validate_held_identity()
            signal.pidfd_send_signal(pidfd, signal.SIGSTOP, None, 0)
            stopped = True
            deadline = time.monotonic() + 5
            while read_state() not in {"T", "t"}:
                if pidfd_exited() or time.monotonic() >= deadline:
                    raise RuntimeError("legacy process did not stop")
                time.sleep(0.05)
            validate_held_identity()
            emit("OK:STOP")
        elif command == "TERM":
            if not stopped:
                raise RuntimeError("legacy process is not stopped")
            validate_held_identity()
            signal.pidfd_send_signal(pidfd, signal.SIGTERM, None, 0)
            signal.pidfd_send_signal(pidfd, signal.SIGCONT, None, 0)
            stopped = False
            if not pidfd_exited(30_000):
                emit("ERROR:TERM_TIMEOUT")
                break
            emit("OK:TERM")
            break
        elif command == "CONT_EXIT":
            if stopped and not pidfd_exited():
                signal.pidfd_send_signal(pidfd, signal.SIGCONT, None, 0)
                stopped = False
            emit("OK:CONT_EXIT")
            break
        else:
            emit("ERROR:UNKNOWN_COMMAND")
            break
except BaseException:
    if responses is not None:
        try:
            emit("ERROR:BROKER")
        except BaseException:
            pass
finally:
    signal.alarm(0)
    if stopped and pidfd is not None:
        try:
            if not pidfd_exited():
                signal.pidfd_send_signal(pidfd, signal.SIGCONT, None, 0)
        except BaseException:
            pass
    if pidfd is not None:
        os.close(pidfd)
PY
  legacy_broker_pid="$!"
  legacy_broker_started=true
  exec 7<>"$legacy_broker_dir/commands"
  exec 8<>"$legacy_broker_dir/responses"
  legacy_broker_fds_open=true
  trap cleanup_legacy_broker EXIT
  trap 'abort_legacy_handoff 129' HUP
  trap 'abort_legacy_handoff 130' INT
  trap 'abort_legacy_handoff 143' TERM
  IFS= read -r -t 20 ready <&8 \
    && [ "$ready" = READY ] \
    || die "legacy pidfd broker did not establish an exact process handle"
}

if [ "$mode" = install-replica ]; then
  [ -n "$source_root" ] && [ -n "$legacy_pid" ] && [ -n "$legacy_exe_digest" ] \
    || die "source root and exact legacy identity are required"
  validate_file "$source_root/$UNIT_RELATIVE" unit root \
    || die "systemd unit source is unsafe"
  unit_digest="$(file_digest "$source_root/$UNIT_RELATIVE")"
  validate_inputs root
  validate_legacy "$legacy_pid" "$legacy_user" "$legacy_exe_digest"
  starttime="$(legacy_starttime "$legacy_pid")"
  write_state prepared "$starttime"
  install_exact "$binary_source" "$BINARY_TARGET" 0755
  install_exact "$config_source" "$CONFIG_TARGET" 0600
  install_exact "$credential_source" "$CREDENTIAL_TARGET" 0600
  install_exact "$source_root/$UNIT_RELATIVE" "$UNIT_TARGET" 0644
  systemctl daemon-reload
  # A prior interrupted attempt may have left this unit active with an older
  # process image or credential snapshot. The legacy connector is still live,
  # so restart deliberately and prove the newly installed inputs before
  # enabling this unit or allowing retirement.
  systemctl restart "$SERVICE"
  verify_new_connector
  systemctl enable "$SERVICE"
  write_state replica_ready "$starttime"
  printf '{"ok":true,"mode":"install-replica","phase":"replica_ready","tokenMaterialEmitted":false}\n'
  exit 0
fi

state_fields="$(read_state)" || die "migration state is invalid"
IFS=$'\t' read -r phase legacy_pid legacy_user recorded_starttime \
  legacy_exe_digest binary_digest config_digest credential_digest unit_digest <<<"$state_fields"
case "$phase" in replica_ready|complete) ;; *) die "replica is not ready for legacy retirement" ;; esac
[ "$(file_digest "$BINARY_TARGET")" = "$binary_digest" ] \
  && [ "$(file_digest "$CONFIG_TARGET")" = "$config_digest" ] \
  && [ "$(file_digest "$CREDENTIAL_TARGET")" = "$credential_digest" ] \
  && [ "$(file_digest "$UNIT_TARGET")" = "$unit_digest" ] \
  || die "installed connector identity drifted"
verify_new_connector
cron_status=0
assert_no_cloudflared_cron_sources || cron_status="$?"
case "$cron_status" in
  0) ;;
  10) die "legacy cron launch is still present; remove it securely with crontab -e" ;;
  *) die "cron launch sources could not be inspected completely" ;;
esac

if [ -e "/proc/$legacy_pid/stat" ]; then
  start_legacy_pidfd_broker
  legacy_broker_command STOP OK:STOP 10 \
    || die "legacy connector did not stop through its exact pidfd"
  verify_new_connector
  verify_new_connector
  verify_new_connector
  legacy_broker_command TERM OK:TERM 35 \
    || die "legacy connector did not terminate gracefully through its exact pidfd"
  legacy_broker_retired=true
  cleanup_legacy_broker
  trap - EXIT HUP INT TERM
fi

new_pid="$(connector_main_pid)"
for proc_comm in /proc/[0-9]*/comm; do
  [ -r "$proc_comm" ] || continue
  [ "$(cat "$proc_comm")" = cloudflared ] || continue
  proc_pid="${proc_comm#/proc/}"
  proc_pid="${proc_pid%/comm}"
  [ "$proc_pid" = "$new_pid" ] || die "an unexpected cloudflared process remains"
done
verify_new_connector
write_state complete "$recorded_starttime"
printf '{"ok":true,"mode":"retire-legacy","phase":"complete","tokenMaterialEmitted":false}\n'
