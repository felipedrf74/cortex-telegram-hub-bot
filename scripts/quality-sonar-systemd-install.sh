#!/usr/bin/env bash
# Transactionally install the advisory SonarQube control assets from the exact
# root-owned protected-main bootstrap archive. This installer never installs or
# invokes Docker, writes secrets, starts/stops/enables units, or writes Sonar
# application/database data.
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

SOURCE_ROOT="${1:-}"
SOURCE_SHA="${2:-}"
SOURCE_ARCHIVE="${3:-}"
EXPECTED_ARCHIVE_SHA256="${4:-}"
BOOTSTRAP_BASE=/var/lib/nexus-release-bootstrap
LAYOUT_RELATIVE=ops/sonarqube/install-layout.tsv
DATA_LAYOUT_RELATIVE=ops/sonarqube/data-layout.tsv
SHARED_MUTEX=/run/lock/nexus-release-sonar.lock
STATE_DIR=/var/lib/nexus-sonarqube
RESTORE_EVIDENCE_DIR="$STATE_DIR/restore-evidence"
INSTALL_JOURNAL="$STATE_DIR/install-in-progress.v1"
INSTALL_RECEIPT="$STATE_DIR/install-receipt.v1.json"
SONAR_SERVICE=nexus-sonarqube.service
BACKUP_SERVICE=nexus-sonarqube-backup.service
BACKUP_TIMER=nexus-sonarqube-backup.timer

die() {
  echo "SonarQube asset installer: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: sudo scripts/quality-sonar-systemd-install.sh \
  <root-owned-source-root> <40-hex-source-sha> \
  <root-owned-source-archive> <64-hex-archive-sha256>
EOF
}

[ $# -eq 4 ] || {
  usage >&2
  exit 64
}
[ "$(id -u)" -eq 0 ] || die "must run as root"
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] \
  || die "source SHA must be exactly 40 lowercase hexadecimal characters"
[[ "$EXPECTED_ARCHIVE_SHA256" =~ ^[0-9a-f]{64}$ ]] \
  || die "archive SHA-256 must be exactly 64 lowercase hexadecimal characters"

EXPECTED_BOOTSTRAP_ROOT="$BOOTSTRAP_BASE/$SOURCE_SHA"
[ "$SOURCE_ROOT" = "$EXPECTED_BOOTSTRAP_ROOT/source" ] \
  || die "source root must be the exact SHA-bound bootstrap source path"
[ "$SOURCE_ARCHIVE" = "$EXPECTED_BOOTSTRAP_ROOT/source.tar.gz" ] \
  || die "source archive must be the exact SHA-bound bootstrap archive path"

for command in awk bash cat chmod cut date dirname flock id install ln mktemp mv \
  node python3 realpath rm rmdir sha256sum stat systemctl systemd-analyze \
  systemd-tmpfiles tail visudo; do
  command -v "$command" >/dev/null 2>&1 || die "$command is required"
done

fsync_path() {
  python3 - "$1" <<'PY'
import os
import sys

descriptor = os.open(sys.argv[1], os.O_RDONLY)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

durable_remove() {
  local target="$1"
  rm -f -- "$target" || return 1
  fsync_path "$(dirname -- "$target")"
}

validate_root_owned_chain() {
  local current="$1" label="${2:-path}" owner mode
  while :; do
    owner="$(stat -c '%U:%G' -- "$current")"
    mode="$(stat -c '%a' -- "$current")"
    [ "$owner" = root:root ] \
      || die "$label component is not root-owned: $current"
    (( (8#$mode & 0022) == 0 )) \
      || die "$label component is group/world writable: $current"
    [ "$current" = / ] && break
    current="$(dirname -- "$current")"
  done
}

validate_root_trusted_path() {
  local candidate="$1" label="$2" expected_type="$3" canonical
  [[ "$candidate" == /* && "$candidate" != / && ! -L "$candidate" ]] \
    || die "$label must be an absolute non-symlink path"
  case "$expected_type" in
    directory) [ -d "$candidate" ] || die "$label must be a directory" ;;
    file) [ -f "$candidate" ] || die "$label must be a regular file" ;;
    *) die "internal path-validator misuse" ;;
  esac
  canonical="$(realpath -e -- "$candidate")"
  [ "$canonical" = "$candidate" ] \
    || die "$label must not traverse symlinks"
  validate_root_owned_chain "$candidate" "$label"
}

validate_existing_target_ancestor() {
  local current="$1" parent canonical
  while [ ! -e "$current" ] && [ ! -L "$current" ]; do
    parent="$(dirname -- "$current")"
    [ "$parent" != "$current" ] \
      || die "install target has no existing trusted ancestor"
    current="$parent"
  done
  [ -d "$current" ] && [ ! -L "$current" ] \
    || die "install target ancestor is unsafe: $current"
  canonical="$(realpath -e -- "$current")"
  [ "$canonical" = "$current" ] \
    || die "install target ancestor traverses a symlink: $current"
  validate_root_owned_chain "$current" "install target"
}

validate_root_trusted_path "$SOURCE_ROOT" "bootstrap source root" directory
validate_root_trusted_path "$SOURCE_ARCHIVE" "bootstrap source archive" file

archive_sha256="$(sha256sum -- "$SOURCE_ARCHIVE" | cut -d' ' -f1)"
[ "$archive_sha256" = "$EXPECTED_ARCHIVE_SHA256" ] \
  || die "bootstrap source archive digest does not match the owner-approved digest"

LAYOUT="$SOURCE_ROOT/$LAYOUT_RELATIVE"
DATA_LAYOUT="$SOURCE_ROOT/$DATA_LAYOUT_RELATIVE"
INSTALLER_SOURCE="$SOURCE_ROOT/scripts/quality-sonar-systemd-install.sh"
validate_root_trusted_path "$LAYOUT" "Sonar install layout" file
validate_root_trusted_path "$DATA_LAYOUT" "Sonar data layout" file
validate_root_trusted_path "$INSTALLER_SOURCE" "Sonar asset installer" file
[[ "${BASH_SOURCE[0]}" == /* && ! -L "${BASH_SOURCE[0]}" ]] \
  && [ "$(realpath -e -- "${BASH_SOURCE[0]}")" = "$INSTALLER_SOURCE" ] \
  || die "installer must execute from the exact reviewed bootstrap source path"

expected_layout="$(
  cat <<'LAYOUT'
ops/sonarqube/compose.yaml	/srv/sonarqube/compose.yaml	root:root	0644
ops/sonarqube/compose.drill.yaml	/srv/sonarqube/compose.drill.yaml	root:root	0644
ops/sonarqube/images.lock.env	/srv/sonarqube/images.lock.env	root:root	0644
ops/sonarqube/data-layout.tsv	/srv/sonarqube/data-layout.tsv	root:root	0644
ops/sonarqube/sonar-project.properties	/srv/sonarqube/sonar-project.properties	root:root	0644
ops/sonarqube/systemd/nexus-sonarqube.service	/etc/systemd/system/nexus-sonarqube.service	root:root	0644
ops/sonarqube/systemd/nexus-sonarqube-backup.service	/etc/systemd/system/nexus-sonarqube-backup.service	root:root	0644
ops/sonarqube/systemd/nexus-sonarqube-backup.timer	/etc/systemd/system/nexus-sonarqube-backup.timer	root:root	0644
scripts/quality-sonar-stack.sh	/usr/local/sbin/quality-sonar-stack	root:root	0755
scripts/quality-sonar-resolve-images.sh	/usr/local/sbin/quality-sonar-resolve-images	root:root	0755
scripts/quality-sonar-health.sh	/usr/local/sbin/quality-sonar-health	root:root	0755
scripts/quality-sonar-preflight.sh	/usr/local/sbin/quality-sonar-preflight	root:root	0755
scripts/ollama-observation-collector.mjs	/usr/local/sbin/nexus-ollama-observation-collector.mjs	root:root	0700
scripts/ollama-soak-evidence.mjs	/usr/local/sbin/ollama-soak-evidence.mjs	root:root	0700
scripts/ollama-large-model-cleanup.mjs	/usr/local/sbin/nexus-ollama-large-model-cleanup.mjs	root:root	0700
scripts/ollama-zero-swap-transition.mjs	/usr/local/sbin/nexus-ollama-zero-swap-transition.mjs	root:root	0700
scripts/ollama-service-envelope-check.mjs	/usr/local/sbin/nexus-ollama-service-envelope-check.mjs	root:root	0700
scripts/lib/ollama-service-envelope.mjs	/usr/local/sbin/lib/ollama-service-envelope.mjs	root:root	0700
scripts/ollama-systemd-dropin-transaction.mjs	/usr/local/sbin/nexus-ollama-systemd-dropin-transaction.mjs	root:root	0700
scripts/ollama-install-state-check.mjs	/usr/local/sbin/nexus-ollama-install-state-check.mjs	root:root	0700
scripts/ollama-observation-control.mjs	/usr/local/sbin/nexus-ollama-observation-control.mjs	root:root	0700
scripts/systemd/00-nexus-ollama-install-guard.conf	/etc/systemd/system/ollama.service.d/00-nexus-ollama-install-guard.conf	root:root	0644
scripts/systemd/nexus-ollama-observation@.service	/etc/systemd/system/nexus-ollama-observation@.service	root:root	0644
scripts/quality-sonar-start-evidence.mjs	/usr/local/sbin/quality-sonar-start-evidence.mjs	root:root	0755
scripts/quality-sonar-live-ollama-state.mjs	/usr/local/sbin/quality-sonar-live-ollama-state	root:root	0755
scripts/quality-sonar-latency-gate.mjs	/usr/local/sbin/quality-sonar-latency-gate.mjs	root:root	0755
scripts/quality-sonar-backup.sh	/usr/local/sbin/quality-sonar-backup	root:root	0755
scripts/aws-credential-process-boundary.py	/usr/local/sbin/quality-sonar-aws-credential-process-boundary.py	root:root	0644
scripts/quality-sonar-retention.mjs	/usr/local/sbin/quality-sonar-retention.mjs	root:root	0755
scripts/quality-sonar-restore-drill.sh	/usr/local/sbin/quality-sonar-restore-drill	root:root	0755
scripts/quality-sonar-release-state.sh	/usr/local/sbin/quality-sonar-release-state	root:root	0755
ops/sonarqube/nexus-sonar-release-monitor.sudoers	/etc/sudoers.d/nexus-sonar-release-monitor	root:root	0440
ops/sonarqube/nexus-release-sonar-lock.conf	/etc/tmpfiles.d/nexus-release-sonar-lock.conf	root:root	0644
LAYOUT
)"
actual_layout="$(tail -n +2 "$LAYOUT")"
[ "$actual_layout" = "$expected_layout" ] \
  || die "install layout differs from the exact embedded allowlist"

expected_data_layout="$(
  cat <<'DATA_LAYOUT'
/srv/sonarqube	0:0	0750	root-controlled stack boundary
/srv/sonarqube/data	0:0	0750	root-controlled persistent-data boundary
/srv/sonarqube/data/postgresql	999:999	0700	pinned PostgreSQL container data
/srv/sonarqube/data/sonarqube	1000:1000	0750	pinned SonarQube application data
/srv/sonarqube/data/extensions	1000:1000	0750	pinned SonarQube extensions
/srv/sonarqube/data/logs	1000:1000	0750	pinned SonarQube logs
/srv/sonarqube/data/temp	1000:1000	0750	pinned SonarQube search temporary data
DATA_LAYOUT
)"
actual_data_layout="$(tail -n +2 "$DATA_LAYOUT")"
[ "$actual_data_layout" = "$expected_data_layout" ] \
  || die "data layout differs from the exact embedded allowlist"

# Prove that the reviewed archive came from the declared Git commit and that
# every executable/install input still matches its exact regular-file member.
python3 - \
  "$SOURCE_ARCHIVE" "$SOURCE_ROOT" "$SOURCE_SHA" "$LAYOUT" \
  "$DATA_LAYOUT" "$INSTALLER_SOURCE" <<'PY'
import hashlib
import pathlib
import sys
import tarfile

archive_path, source_root, source_sha, layout_path, data_layout_path, installer_path = sys.argv[1:]
source_root_path = pathlib.Path(source_root)

required = {
    "ops/sonarqube/install-layout.tsv",
    "ops/sonarqube/data-layout.tsv",
    "scripts/quality-sonar-systemd-install.sh",
}
with open(layout_path, "r", encoding="utf-8") as layout:
    for line_number, raw_line in enumerate(layout, start=1):
        line = raw_line.rstrip("\n")
        if line_number == 1 or not line:
            continue
        fields = line.split("\t")
        if len(fields) != 4:
            raise SystemExit("Sonar install archive verifier: malformed install layout")
        required.add(fields[0])

with tarfile.open(archive_path, mode="r:*") as archive:
    if archive.pax_headers.get("comment") != source_sha:
        raise SystemExit("Sonar install archive verifier: Git archive commit does not match source SHA")
    required_members = {}
    expected_names = {f"source/{relative}": relative for relative in required}
    for member in archive.getmembers():
        relative = expected_names.get(member.name)
        if relative is None:
            continue
        if relative in required_members:
            raise SystemExit(f"Sonar install archive verifier: duplicate member {member.name}")
        if not member.isreg() or member.issym() or member.islnk():
            raise SystemExit(f"Sonar install archive verifier: required member is not regular: {member.name}")
        required_members[relative] = member
    missing = sorted(required - required_members.keys())
    if missing:
        raise SystemExit(f"Sonar install archive verifier: missing required member {missing[0]}")
    for relative in sorted(required):
        member = required_members[relative]
        extracted = archive.extractfile(member)
        if extracted is None:
            raise SystemExit(f"Sonar install archive verifier: cannot read {member.name}")
        archive_digest = hashlib.sha256(extracted.read()).hexdigest()
        local_path = source_root_path / relative
        if not local_path.is_file() or local_path.is_symlink():
            raise SystemExit(f"Sonar install archive verifier: unsafe source {relative}")
        local_digest = hashlib.sha256(local_path.read_bytes()).hexdigest()
        if local_digest != archive_digest:
            raise SystemExit(f"Sonar install archive verifier: source drift for {relative}")

for path in (data_layout_path, installer_path):
    if pathlib.Path(path).is_symlink():
        raise SystemExit("Sonar install archive verifier: required source is a symlink")
PY

sources=()
targets=()
owners=()
groups=()
modes=()
had_targets=()
declare -A seen_sources=()
declare -A seen_targets=()
service_index=-1

while IFS=$'\t' read -r relative target owner mode extra; do
  [ -z "$extra" ] || die "install layout contains an extra column"
  [ -n "$relative" ] && [ -n "$target" ] && [ -n "$owner" ] && [ -n "$mode" ] \
    || die "install layout contains an incomplete row"
  [[ "$relative" =~ ^[A-Za-z0-9._/-]+$ ]] \
    && [[ "/$relative/" != *"/../"* && "/$relative/" != *"/./"* ]] \
    && [[ "$relative" != /* ]] \
    || die "install layout source is unsafe"
  [ -z "${seen_sources[$relative]:-}" ] \
    || die "install layout repeats source: $relative"
  [ -z "${seen_targets[$target]:-}" ] \
    || die "install layout repeats target: $target"
  seen_sources[$relative]=1
  seen_targets[$target]=1

  source_path="$SOURCE_ROOT/$relative"
  validate_root_trusted_path "$source_path" "Sonar install source ($relative)" file
  [ "$owner" = root:root ] || die "install target owner is outside the allowlist"
  case "$mode" in 0440|0644|0700|0755) ;; *) die "install target mode is outside the allowlist" ;; esac
  [[ "$target" == /* && "$target" != / ]] \
    && [ "$(realpath -m -- "$target")" = "$target" ] \
    || die "install target is noncanonical: $target"
  case "$target" in
    /srv/sonarqube/compose.yaml|\
    /srv/sonarqube/compose.drill.yaml|\
    /srv/sonarqube/images.lock.env|\
    /srv/sonarqube/data-layout.tsv|\
    /srv/sonarqube/sonar-project.properties|\
    /etc/systemd/system/nexus-sonarqube.service|\
    /etc/systemd/system/nexus-sonarqube-backup.service|\
    /etc/systemd/system/nexus-sonarqube-backup.timer|\
    /usr/local/sbin/quality-sonar-stack|\
    /usr/local/sbin/quality-sonar-resolve-images|\
    /usr/local/sbin/quality-sonar-health|\
    /usr/local/sbin/quality-sonar-preflight|\
    /usr/local/sbin/nexus-ollama-observation-collector.mjs|\
    /usr/local/sbin/ollama-soak-evidence.mjs|\
    /usr/local/sbin/nexus-ollama-large-model-cleanup.mjs|\
    /usr/local/sbin/nexus-ollama-zero-swap-transition.mjs|\
    /usr/local/sbin/nexus-ollama-service-envelope-check.mjs|\
    /usr/local/sbin/lib/ollama-service-envelope.mjs|\
    /usr/local/sbin/nexus-ollama-systemd-dropin-transaction.mjs|\
    /usr/local/sbin/nexus-ollama-install-state-check.mjs|\
    /usr/local/sbin/nexus-ollama-observation-control.mjs|\
    /etc/systemd/system/ollama.service.d/00-nexus-ollama-install-guard.conf|\
    /etc/systemd/system/nexus-ollama-observation@.service|\
    /usr/local/sbin/quality-sonar-start-evidence.mjs|\
    /usr/local/sbin/quality-sonar-live-ollama-state|\
    /usr/local/sbin/quality-sonar-latency-gate.mjs|\
    /usr/local/sbin/quality-sonar-backup|\
    /usr/local/sbin/quality-sonar-aws-credential-process-boundary.py|\
    /usr/local/sbin/quality-sonar-retention.mjs|\
    /usr/local/sbin/quality-sonar-restore-drill|\
    /usr/local/sbin/quality-sonar-release-state|\
    /etc/sudoers.d/nexus-sonar-release-monitor|\
    /etc/tmpfiles.d/nexus-release-sonar-lock.conf) ;;
    *) die "install target is outside the exact allowlist: $target" ;;
  esac

  validate_existing_target_ancestor "$(dirname -- "$target")"
  if [ -L "$target" ]; then
    die "existing install target is a symlink: $target"
  elif [ -e "$target" ]; then
    [ -f "$target" ] || die "existing install target is not a regular file: $target"
    [ "$(realpath -e -- "$target")" = "$target" ] \
      || die "existing install target traverses a symlink: $target"
    validate_root_owned_chain "$target" "existing install target"
    had_targets+=(true)
  else
    had_targets+=(false)
  fi
  IFS=: read -r owner_name group_name <<< "$owner"
  sources+=("$source_path")
  targets+=("$target")
  owners+=("$owner_name")
  groups+=("$group_name")
  modes+=("$mode")
  if [ "$target" = "/etc/systemd/system/$SONAR_SERVICE" ]; then
    service_index=$((${#targets[@]} - 1))
  fi
done <<< "$actual_layout"

planned="${#sources[@]}"
[ "$planned" -gt 0 ] || die "install layout is empty"
[ "$service_index" -ge 0 ] || die "install layout omits the journal-guarded Sonar service"

data_paths=()
data_owners=()
data_groups=()
data_modes=()
while IFS=$'\t' read -r path numeric_owner mode purpose extra; do
  [ -z "$extra" ] || die "data layout contains an extra column"
  [ -n "$path" ] && [ -n "$numeric_owner" ] && [ -n "$mode" ] && [ -n "$purpose" ] \
    || die "data layout contains an incomplete row"
  [[ "$path" == /srv/sonarqube || "$path" == /srv/sonarqube/data || "$path" == /srv/sonarqube/data/* ]] \
    && [ "$(realpath -m -- "$path")" = "$path" ] \
    || die "data layout path is outside the exact allowlist"
  [[ "$numeric_owner" =~ ^[0-9]+:[0-9]+$ ]] \
    || die "data layout owner must be numeric"
  case "$mode" in 0700|0750) ;; *) die "data layout mode is outside the allowlist" ;; esac
  validate_existing_target_ancestor "$(dirname -- "$path")"
  if [ -L "$path" ]; then
    die "existing Sonar directory is a symlink: $path"
  elif [ -e "$path" ]; then
    [ -d "$path" ] || die "existing Sonar directory is not a directory: $path"
    [ "$(realpath -e -- "$path")" = "$path" ] \
      || die "existing Sonar directory traverses a symlink: $path"
    [ "$(stat -c '%u:%g' -- "$path")" = "$numeric_owner" ] \
      || die "existing Sonar directory owner differs from the data layout: $path"
    [ "$(stat -c '%a' -- "$path")" = "${mode#0}" ] \
      || die "existing Sonar directory mode differs from the data layout: $path"
  fi
  IFS=: read -r numeric_uid numeric_gid <<< "$numeric_owner"
  data_paths+=("$path")
  data_owners+=("$numeric_uid")
  data_groups+=("$numeric_gid")
  data_modes+=("$mode")
done <<< "$actual_data_layout"

validate_managed_directory() {
  local path="$1" owner="$2" group="$3" mode="$4"
  validate_existing_target_ancestor "$(dirname -- "$path")"
  if [ -L "$path" ]; then
    die "managed directory is a symlink: $path"
  elif [ -e "$path" ]; then
    [ -d "$path" ] || die "managed path is not a directory: $path"
    [ "$(realpath -e -- "$path")" = "$path" ] \
      || die "managed directory traverses a symlink: $path"
    [ "$(stat -c '%U:%G' -- "$path")" = "$owner:$group" ] \
      || die "managed directory owner is invalid: $path"
    [ "$(stat -c '%a' -- "$path")" = "${mode#0}" ] \
      || die "managed directory mode is invalid: $path"
  fi
}

validate_managed_directory /usr/local/sbin/lib root root 0755
validate_managed_directory /etc/systemd/system/ollama.service.d root root 0755
validate_managed_directory /etc/sonarqube root root 0700
validate_managed_directory "$STATE_DIR" root root 0700
validate_managed_directory "$RESTORE_EVIDENCE_DIR" root root 0700

if [ -L "$INSTALL_JOURNAL" ]; then
  die "install journal is a symlink"
elif [ -e "$INSTALL_JOURNAL" ]; then
  [ -f "$INSTALL_JOURNAL" ] \
    && [ "$(stat -c '%U:%G:%a' -- "$INSTALL_JOURNAL")" = root:root:600 ] \
    || die "preexisting install journal is unsafe"
  die "an incomplete Sonar asset installation requires owner inspection"
fi
if [ -L "$INSTALL_RECEIPT" ]; then
  die "install receipt is a symlink"
elif [ -e "$INSTALL_RECEIPT" ]; then
  [ -f "$INSTALL_RECEIPT" ] \
    && [ "$(stat -c '%U:%G:%a' -- "$INSTALL_RECEIPT")" = root:root:600 ] \
    || die "preexisting install receipt is unsafe"
fi

unit_state() {
  systemctl is-enabled "$1" 2>/dev/null || true
}

assert_unit_inactive() {
  local unit="$1" state rc
  if state="$(systemctl is-active "$unit" 2>/dev/null)"; then
    rc=0
  else
    rc=$?
  fi
  case "$state:$rc" in
    inactive:3|failed:3|unknown:4|not-found:4) ;;
    *) die "unable to prove unit is safely inactive: $unit" ;;
  esac
}

assert_units_untouched_and_disabled() {
  local service_state backup_state timer_state unit
  for unit in "$SONAR_SERVICE" "$BACKUP_SERVICE" "$BACKUP_TIMER"; do
    assert_unit_inactive "$unit"
  done
  service_state="$(unit_state "$SONAR_SERVICE")"
  backup_state="$(unit_state "$BACKUP_SERVICE")"
  timer_state="$(unit_state "$BACKUP_TIMER")"
  case "$service_state" in disabled|not-found) ;; *) die "$SONAR_SERVICE must remain disabled" ;; esac
  case "$backup_state" in static|disabled|not-found) ;; *) die "$BACKUP_SERVICE has an unexpected enablement state" ;; esac
  case "$timer_state" in disabled|not-found) ;; *) die "$BACKUP_TIMER must remain disabled" ;; esac
}
assert_units_untouched_and_disabled

[ -f "$SHARED_MUTEX" ] && [ ! -L "$SHARED_MUTEX" ] \
  || die "preprovisioned shared release/Sonar mutex is missing"
[ "$(stat -c '%U:%G:%a' -- "$SHARED_MUTEX")" = root:dominguez:660 ] \
  || die "shared release/Sonar mutex must be root:dominguez mode 0660"
exec 9<>"$SHARED_MUTEX"
flock -n 9 || die "a release, advisory scan, stack operation, or installer holds the shared mutex"

# Complete every source-only validation before creating a directory or staging
# a target.
for source_path in "${sources[@]}"; do
  case "$source_path" in
    *.sh) bash -n "$source_path" ;;
    *.mjs) node --check "$source_path" >/dev/null ;;
  esac
done
bash "$SOURCE_ROOT/scripts/quality-sonar-resolve-images.sh" \
  --verify-lock-only \
  --lock-file "$SOURCE_ROOT/ops/sonarqube/images.lock.env" >/dev/null
visudo -cf "$SOURCE_ROOT/ops/sonarqube/nexus-sonar-release-monitor.sudoers" >/dev/null
python3 - "$SOURCE_ROOT/ops/sonarqube/compose.yaml" <<'PY'
import pathlib
import sys

compose = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
postgres_start = compose.find("  postgres:")
sonar_start = compose.find("  sonarqube:")
if postgres_start < 0 or sonar_start <= postgres_start:
    raise SystemExit("Sonar Compose prevalidation: required services are absent")
postgres = compose[postgres_start:sonar_start]
required = (
    '"127.0.0.1:9000:9000"',
    "internal: true",
    "create_host_path: false",
)
if any(value not in compose for value in required):
    raise SystemExit("Sonar Compose prevalidation: isolation requirement is absent")
if "ports:" in postgres or "0.0.0.0:9000" in compose:
    raise SystemExit("Sonar Compose prevalidation: public/database listener is forbidden")
if compose.count('restart: "no"') != 2:
    raise SystemExit("Sonar Compose prevalidation: both restart policies must be disabled")
PY

created_dirs=()
stage_paths=()
backup_paths=()
committed_indices=()
receipt_stage=""
receipt_backup=""
receipt_assets=""
journal_tmp=""
receipt_had_target=false
receipt_committed=false
journal_armed=false
rollback_abandoned=false
install_succeeded=false

cleanup_install() {
  local rc=$? position index target backup stage rollback_failed=false
  trap - EXIT INT TERM
  set +e
  if [ "$install_succeeded" != true ] && [ "$rollback_abandoned" = false ]; then
    if [ "$receipt_committed" = true ]; then
      if [ "$receipt_had_target" = true ]; then
        if [ -f "$receipt_backup" ] \
            && mv -fT -- "$receipt_backup" "$INSTALL_RECEIPT" \
            && fsync_path "$STATE_DIR"; then
          receipt_backup=""
        else
          rollback_failed=true
          echo "SonarQube asset installer: failed to restore the prior install receipt" >&2
        fi
      elif ! durable_remove "$INSTALL_RECEIPT"; then
        rollback_failed=true
        echo "SonarQube asset installer: failed to remove the new install receipt" >&2
      fi
    fi
    for ((position=${#committed_indices[@]} - 1; position >= 0; position -= 1)); do
      index="${committed_indices[$position]}"
      target="${targets[$index]}"
      backup="${backup_paths[$index]:-}"
      if [ "${had_targets[$index]}" = true ]; then
        if [ -n "$backup" ] && [ -f "$backup" ]; then
          if mv -fT -- "$backup" "$target" \
              && fsync_path "$(dirname -- "$target")"; then
            backup_paths[$index]=""
          else
            rollback_failed=true
            echo "SonarQube asset installer: failed to restore $target from $backup" >&2
          fi
        fi
      elif ! durable_remove "$target"; then
        rollback_failed=true
        echo "SonarQube asset installer: failed to remove new target $target" >&2
      fi
    done
    if [ "${#committed_indices[@]}" -gt 0 ] \
        && ! systemctl daemon-reload >/dev/null 2>&1; then
      rollback_failed=true
      echo "SonarQube asset installer: failed to reload systemd after rollback" >&2
    fi
  elif [ "$install_succeeded" != true ]; then
    rollback_failed=true
    echo "SonarQube asset installer: installation stopped after rollback backups were retired" >&2
  fi

  [ -z "$journal_tmp" ] || durable_remove "$journal_tmp"
  [ -z "$receipt_stage" ] || durable_remove "$receipt_stage"
  [ -z "$receipt_assets" ] || durable_remove "$receipt_assets"
  for stage in "${stage_paths[@]:-}"; do
    [ -z "$stage" ] || durable_remove "$stage"
  done
  if [ "$install_succeeded" = true ]; then
    [ -z "$receipt_backup" ] || durable_remove "$receipt_backup"
    for backup in "${backup_paths[@]:-}"; do
      [ -z "$backup" ] || durable_remove "$backup"
    done
  fi

  if [ "$install_succeeded" != true ] \
      && [ "$rollback_failed" = false ] \
      && [ "$journal_armed" = true ]; then
    if durable_remove "$INSTALL_JOURNAL"; then
      journal_armed=false
    else
      rollback_failed=true
      echo "SonarQube asset installer: failed to clear the install journal after rollback" >&2
    fi
  fi
  if [ "$install_succeeded" != true ] && [ "$rollback_failed" = false ]; then
    for ((position=${#created_dirs[@]} - 1; position >= 0; position -= 1)); do
      rmdir -- "${created_dirs[$position]}" >/dev/null 2>&1 || true
    done
  fi
  if [ "$rollback_failed" = true ]; then
    rc=1
  fi
  exit "$rc"
}
trap cleanup_install EXIT
trap 'exit 130' INT TERM

ensure_directory() {
  local path="$1" owner="$2" group="$3" mode="$4" parent
  if [ -d "$path" ]; then
    return
  fi
  parent="$(dirname -- "$path")"
  [ -d "$parent" ] && [ ! -L "$parent" ] \
    && [ "$(realpath -e -- "$parent")" = "$parent" ] \
    || die "managed directory parent must already exist and be canonical: $parent"
  install -d -o "$owner" -g "$group" -m "$mode" -- "$path"
  created_dirs+=("$path")
  fsync_path "$path"
  fsync_path "$parent"
}

ensure_directory /usr/local/sbin/lib root root 0755
ensure_directory /etc/systemd/system/ollama.service.d root root 0755
ensure_directory /etc/sonarqube root root 0700
ensure_directory "$STATE_DIR" root root 0700
ensure_directory "$RESTORE_EVIDENCE_DIR" root root 0700
for ((index=0; index<${#data_paths[@]}; index+=1)); do
  ensure_directory \
    "${data_paths[$index]}" \
    "${data_owners[$index]}" \
    "${data_groups[$index]}" \
    "${data_modes[$index]}"
done

journal_tmp="$(mktemp -p "$STATE_DIR" ".install-in-progress.v1.tmp.XXXXXX")"
printf '{"schema":"nexus.sonarqube-asset-install-journal.v1","status":"in_progress","sourceSha":"%s","archiveSha256":"%s"}\n' \
  "$SOURCE_SHA" "$EXPECTED_ARCHIVE_SHA256" >"$journal_tmp"
chmod 0600 "$journal_tmp"
fsync_path "$journal_tmp"
mv -fT -- "$journal_tmp" "$INSTALL_JOURNAL"
journal_tmp=""
fsync_path "$STATE_DIR"
journal_armed=true

for ((index=0; index<planned; index+=1)); do
  target="${targets[$index]}"
  target_parent="$(dirname -- "$target")"
  stage="$(mktemp -p "$target_parent" ".nexus-sonarqube.stage.XXXXXX")"
  install -o "${owners[$index]}" -g "${groups[$index]}" \
    -m "${modes[$index]}" -- "${sources[$index]}" "$stage"
  [ "$(sha256sum -- "${sources[$index]}" | cut -d' ' -f1)" \
      = "$(sha256sum -- "$stage" | cut -d' ' -f1)" ] \
    || die "staged asset digest differs from its source: $target"
  fsync_path "$stage"
  stage_paths[$index]="$stage"
  backup_paths[$index]=""
done

commit_asset() {
  local index="$1" target target_parent backup
  target="${targets[$index]}"
  target_parent="$(dirname -- "$target")"
  committed_indices+=("$index")
  if [ "${had_targets[$index]}" = true ]; then
    backup="$(mktemp -p "$target_parent" ".nexus-sonarqube.backup.XXXXXX")"
    rm -f -- "$backup"
    backup_paths[$index]="$backup"
    ln -- "$target" "$backup"
    fsync_path "$target_parent"
  fi
  mv -fT -- "${stage_paths[$index]}" "$target"
  fsync_path "$target_parent"
  stage_paths[$index]=""
}

# Commit the journal-aware service first. A reboot during the remaining
# replacements reloads this unit from disk and refuses Sonar startup.
commit_asset "$service_index"
for ((index=0; index<planned; index+=1)); do
  [ "$index" -eq "$service_index" ] && continue
  commit_asset "$index"
done

systemctl daemon-reload
systemd-analyze verify \
  /etc/systemd/system/nexus-sonarqube.service \
  /etc/systemd/system/nexus-sonarqube-backup.service \
  /etc/systemd/system/nexus-sonarqube-backup.timer \
  /etc/systemd/system/nexus-ollama-observation@.service >/dev/null
systemd-tmpfiles --create /etc/tmpfiles.d/nexus-release-sonar-lock.conf
[ -f "$SHARED_MUTEX" ] && [ ! -L "$SHARED_MUTEX" ] \
  && [ "$(stat -c '%U:%G:%a' -- "$SHARED_MUTEX")" = root:dominguez:660 ] \
  || die "shared release/Sonar mutex changed during installation"
assert_units_untouched_and_disabled

receipt_assets="$(mktemp -p "$STATE_DIR" ".install-assets.XXXXXX")"
for ((index=0; index<planned; index+=1)); do
  printf '%s\t%s\t%s:%s\t%s\n' \
    "${targets[$index]}" \
    "$(sha256sum -- "${targets[$index]}" | cut -d' ' -f1)" \
    "${owners[$index]}" "${groups[$index]}" "${modes[$index]}" \
    >>"$receipt_assets"
done
chmod 0600 "$receipt_assets"
receipt_stage="$(mktemp -p "$STATE_DIR" ".install-receipt.v1.stage.XXXXXX")"
python3 - \
  "$SOURCE_SHA" "$EXPECTED_ARCHIVE_SHA256" "$receipt_assets" \
  "$receipt_stage" <<'PY'
import datetime
import json
import pathlib
import sys

source_sha, archive_sha256, assets_path, output_path = sys.argv[1:]
assets = []
for line in pathlib.Path(assets_path).read_text(encoding="utf-8").splitlines():
    target, digest, owner, mode = line.split("\t")
    assets.append({
        "target": target,
        "sha256": digest,
        "owner": owner,
        "mode": mode,
    })
receipt = {
    "schema": "nexus.sonarqube-asset-install.v1",
    "status": "complete",
    "sourceSha": source_sha,
    "archiveSha256": archive_sha256,
    "installedAssets": len(assets),
    "assets": assets,
    "configurationWritten": False,
    "dockerTouched": False,
    "servicesEnabled": False,
    "applicationDataWritten": False,
    "installedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
pathlib.Path(output_path).write_text(
    json.dumps(receipt, sort_keys=True, separators=(",", ":")) + "\n",
    encoding="utf-8",
)
PY
chmod 0600 "$receipt_stage"
fsync_path "$receipt_stage"
durable_remove "$receipt_assets"
receipt_assets=""

if [ -e "$INSTALL_RECEIPT" ]; then
  receipt_had_target=true
  receipt_backup="$(mktemp -p "$STATE_DIR" ".install-receipt.v1.backup.XXXXXX")"
  rm -f -- "$receipt_backup"
  ln -- "$INSTALL_RECEIPT" "$receipt_backup"
  fsync_path "$STATE_DIR"
fi
# A normal signal may not observe a renamed receipt without its rollback state.
# Power loss remains fail-closed because the durable install journal persists.
trap '' INT TERM
mv -fT -- "$receipt_stage" "$INSTALL_RECEIPT"
receipt_stage=""
receipt_committed=true
trap 'exit 130' INT TERM
fsync_path "$STATE_DIR"

rollback_abandoned=true
for backup in "${backup_paths[@]:-}"; do
  [ -z "$backup" ] || durable_remove "$backup"
done
if [ -n "$receipt_backup" ]; then
  durable_remove "$receipt_backup"
  receipt_backup=""
fi
durable_remove "$INSTALL_JOURNAL"
journal_armed=false
install_succeeded=true

printf '{"ok":true,"schema":"nexus.sonarqube-asset-install.v1","sourceSha":"%s","archiveSha256":"%s","installedAssets":%d,"configurationWritten":false,"dockerTouched":false,"servicesEnabled":false,"applicationDataWritten":false}\n' \
  "$SOURCE_SHA" "$EXPECTED_ARCHIVE_SHA256" "$planned"
