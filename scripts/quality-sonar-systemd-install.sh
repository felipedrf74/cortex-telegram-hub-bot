#!/usr/bin/env bash
# Transactionally install the advisory SonarQube control assets from the exact
# root-owned protected-main bootstrap archive. This installer never installs or
# mutates Docker, writes secrets, starts runtime units, or writes Sonar
# application/database contents. It reads Docker authority and its userns map,
# then enables only its journal-conditioned recovery unit so an interrupted
# asset replacement is repaired on the next boot.
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

SOURCE_ROOT="${1:-}"
SOURCE_SHA="${2:-}"
SOURCE_ARCHIVE="${3:-}"
EXPECTED_ARCHIVE_SHA256="${4:-}"
PRE_DOCKER_PREFLIGHT_ONLY=false
PRE_DOCKER_PREFLIGHT_OUTPUT=""
if [ "${5:-}" = "--pre-docker-preflight-only" ] && [ "$#" -eq 6 ]; then
  PRE_DOCKER_PREFLIGHT_ONLY=true
  PRE_DOCKER_PREFLIGHT_OUTPUT="$6"
elif [ "$#" -ne 4 ]; then
  PRE_DOCKER_PREFLIGHT_ONLY=invalid
fi
BOOTSTRAP_BASE=/var/lib/nexus-release-bootstrap
LAYOUT_RELATIVE=ops/sonarqube/install-layout.tsv
DATA_LAYOUT_RELATIVE=ops/sonarqube/data-layout.tsv
SHARED_MUTEX=/run/lock/nexus-release-sonar.lock
SHARED_MUTEX_CONFIG=/etc/tmpfiles.d/nexus-release-sonar-lock.conf
CONTROL_PARENT=/var/lib/nexus-release-promotion
CONTROL_ROOT="$CONTROL_PARENT/sonarqube-install-control"
CONTROL_ROOT_INTENT="$CONTROL_PARENT/sonarqube-install-control-in-progress.v1.json"
CONTROL_ROOT_RECEIPT="$CONTROL_PARENT/sonarqube-install-control.v1.json"
STATE_DIR=/var/lib/nexus-sonarqube
RESTORE_EVIDENCE_DIR="$STATE_DIR/restore-evidence"
INSTALL_JOURNAL="$CONTROL_ROOT/asset-install-in-progress.v2"
INSTALL_RECEIPT="$STATE_DIR/install-receipt.v1.json"
INSTALL_RECOVERY_PROGRAM="$CONTROL_ROOT/install-recovery-program.v2.py"
INSTALL_RECOVERY_RECEIPT="$CONTROL_ROOT/asset-install-recovery-receipt.v1.json"
DIRECTORY_JOURNAL="$CONTROL_ROOT/directory-install-in-progress.v1.json"
DIRECTORY_RECOVERY_RECEIPT="$CONTROL_ROOT/directory-install-recovery-receipt.v1.json"
RECOVERY_ANCHOR_RECEIPT="$CONTROL_ROOT/recovery-anchor-enrollment.v2.json"
RECOVERY_ANCHOR_INTENT="$CONTROL_ROOT/recovery-anchor-enrollment-in-progress.v2.json"
ANCHOR_UNENROLL_JOURNAL="$CONTROL_ROOT/recovery-anchor-unenrollment-in-progress.v1.json"
ANCHOR_UNENROLL_RESULT="$CONTROL_ROOT/recovery-anchor-unenrollment-result.v1.json"
ANCHOR_UNENROLL_ARCHIVE="$CONTROL_ROOT/recovery-anchor-unenrollment-result-archive.v1.json"
INSTALL_COMMIT="$CONTROL_ROOT/install-commit.v1.json"
SONAR_SERVICE=nexus-sonarqube.service
BACKUP_SERVICE=nexus-sonarqube-backup.service
BACKUP_TIMER=nexus-sonarqube-backup.timer
INSTALL_RECOVERY_SERVICE=nexus-sonarqube-install-recovery.service

die() {
  echo "SonarQube asset installer: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: sudo scripts/quality-sonar-systemd-install.sh \
  <root-owned-source-root> <40-hex-source-sha> \
  <root-owned-source-archive> <64-hex-archive-sha256> \
  [--pre-docker-preflight-only <new-private-output-directory>]
EOF
}

[ "$PRE_DOCKER_PREFLIGHT_ONLY" != invalid ] || {
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
if [ "$PRE_DOCKER_PREFLIGHT_ONLY" = true ]; then
  [[ "$PRE_DOCKER_PREFLIGHT_OUTPUT" =~ ^/[A-Za-z0-9._/-]+$ ]] \
    && [ "$PRE_DOCKER_PREFLIGHT_OUTPUT" != / ] \
    && [ "$(realpath -m -- "$PRE_DOCKER_PREFLIGHT_OUTPUT")" \
      = "$PRE_DOCKER_PREFLIGHT_OUTPUT" ] \
    || die "pre-Docker preflight output must be a safe canonical absolute path"
  [ ! -e "$PRE_DOCKER_PREFLIGHT_OUTPUT" ] \
    && [ ! -L "$PRE_DOCKER_PREFLIGHT_OUTPUT" ] \
    || die "pre-Docker preflight output must not already exist"
  validate_root_trusted_path \
    "$(dirname -- "$PRE_DOCKER_PREFLIGHT_OUTPUT")" \
    "pre-Docker preflight output parent" directory
fi

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
ops/sonarqube/systemd/nexus-sonarqube-install-recovery.service	/etc/systemd/system/nexus-sonarqube-install-recovery.service	root:root	0644
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
scripts/quality-sonar-stack-receipt.mjs	/usr/local/sbin/quality-sonar-stack-receipt.mjs	root:root	0700
scripts/quality-sonar-aws-stack-state.mjs	/usr/local/sbin/quality-sonar-aws-stack-state	root:root	0700
scripts/quality-sonar-cloudformation-activate.py	/usr/local/sbin/quality-sonar-cloudformation-activate	root:root	0700
scripts/quality-sonar-release-state.sh	/usr/local/sbin/quality-sonar-release-state	root:root	0755
scripts/quality-sonar-install-transaction.py	/usr/local/sbin/quality-sonar-install-transaction.py	root:root	0700
ops/sonarqube/nexus-sonar-release-monitor.sudoers	/etc/sudoers.d/nexus-sonar-release-monitor	root:root	0440
LAYOUT
)"
actual_layout="$(tail -n +2 "$LAYOUT")"
[ "$actual_layout" = "$expected_layout" ] \
  || die "install layout differs from the exact embedded allowlist"

expected_data_layout="$(
  cat <<'DATA_LAYOUT'
/srv/sonarqube	0:0	0750	root-controlled stack boundary
/srv/sonarqube/data	0:0	0750	root-controlled persistent-data boundary
/srv/sonarqube/data/postgresql	999:999	0700	userns-mapped PostgreSQL container data
/srv/sonarqube/data/sonarqube	1000:1000	0750	userns-mapped SonarQube application data
/srv/sonarqube/data/extensions	1000:1000	0750	userns-mapped SonarQube extensions
/srv/sonarqube/data/logs	1000:1000	0750	userns-mapped SonarQube logs
/srv/sonarqube/data/temp	1000:1000	0750	userns-mapped SonarQube search temporary data
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
    "ops/sonarqube/nexus-release-sonar-lock.conf",
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

# Recovery must precede any live mapping or managed-directory validation. A
# power loss may leave a `creating` directory at the installer's restrictive
# bootstrap owner/mode; only the durable external journal may classify and
# remove it.
# The promotion control plane owns this lock rule because the release path,
# Sonar operations, scans, and backups all share the mutex. Sonar may use the
# exact global predecessor but must never bootstrap or retire it. Recreate only
# the volatile /run file from that preserved, archive-matching rule so
# post-reboot recovery can take the same lock before any managed mutation.
validate_root_trusted_path \
  "$SHARED_MUTEX_CONFIG" "shared release/Sonar tmpfiles config" file
[ "$(stat -c '%U:%G:%a' -- "$SHARED_MUTEX_CONFIG")" = root:root:644 ] \
  || die "shared release/Sonar tmpfiles config must be root:root mode 0644"
SHARED_MUTEX_CONFIG_SHA256="$(
  sha256sum -- "$SHARED_MUTEX_CONFIG" | cut -d' ' -f1
)"
[ "$SHARED_MUTEX_CONFIG_SHA256" = \
    "$(sha256sum -- "$SOURCE_ROOT/ops/sonarqube/nexus-release-sonar-lock.conf" \
      | cut -d' ' -f1)" ] \
  || die "shared release/Sonar tmpfiles config differs from protected main"
SHARED_MUTEX_CONFIG_UID="$(stat -c '%u' -- "$SHARED_MUTEX_CONFIG")"
SHARED_MUTEX_CONFIG_GID="$(stat -c '%g' -- "$SHARED_MUTEX_CONFIG")"
SHARED_MUTEX_CONFIG_MODE="0$(stat -c '%a' -- "$SHARED_MUTEX_CONFIG")"
SHARED_MUTEX_CONFIG_DEV="$(stat -c '%d' -- "$SHARED_MUTEX_CONFIG")"
SHARED_MUTEX_CONFIG_INO="$(stat -c '%i' -- "$SHARED_MUTEX_CONFIG")"
SHARED_MUTEX_CONFIG_NLINK="$(stat -c '%h' -- "$SHARED_MUTEX_CONFIG")"

if [ "$PRE_DOCKER_PREFLIGHT_ONLY" = true ]; then
  # This is the sole pre-Docker entry point. It validates the complete exact
  # archive above, requires the promotion-owned mutex to preexist, and holds
  # that mutex until result.json is published last by the read-only recorder.
  # It never materializes the mutex, resumes an install, creates a Sonar
  # control/data directory, installs an asset, or invokes Docker mutation.
  [ -f "$SHARED_MUTEX" ] && [ ! -L "$SHARED_MUTEX" ] \
    && [ "$(stat -c '%U:%G:%a' -- "$SHARED_MUTEX")" = root:dominguez:660 ] \
    || die "pre-Docker preflight requires the existing shared release/Sonar mutex"
  exec 9<>"$SHARED_MUTEX"
  flock -n 9 \
    || die "a release, advisory scan, stack operation, or installer holds the shared mutex"

  bash -n "$SOURCE_ROOT/scripts/quality-sonar-preflight.sh"
  /usr/bin/node --check \
    "$SOURCE_ROOT/scripts/quality-sonar-start-evidence.mjs" >/dev/null
  assert_pre_docker_absent_boundary() {
    local phase="$1" pre_docker_boundary
    pre_docker_boundary="$(
      bash "$SOURCE_ROOT/scripts/quality-sonar-preflight.sh" \
        --verify-runtime-boundary-only \
        --allow-docker-absent \
        --sample-seconds 0
    )" || die "pre-Docker runtime boundary rejected $phase baseline capture"
    /usr/bin/node - "$pre_docker_boundary" <<'NODE' \
      || die "pre-Docker runtime boundary did not prove Docker absent during $phase"
const lines = process.argv[2].trim().split('\n');
let authority;
try {
  authority = JSON.parse(lines[0] || '');
} catch {
  process.exit(1);
}
if (authority?.schema !== 'nexus.sonarqube-runtime-authority.v1'
    || authority?.status !== 'passed'
    || authority?.dockerAuthority !== 'not_installed'
    || authority?.dockerUserns !== null) process.exit(1);
NODE
  }
  assert_pre_docker_absent_boundary initial

  bash "$SOURCE_ROOT/scripts/quality-sonar-preflight.sh" \
    --output "$PRE_DOCKER_PREFLIGHT_OUTPUT" \
    || die "pre-Docker network/capacity baseline failed"
  validate_root_trusted_path \
    "$PRE_DOCKER_PREFLIGHT_OUTPUT" \
    "pre-Docker preflight evidence" directory
  [ "$(stat -c '%U:%G:%a' -- "$PRE_DOCKER_PREFLIGHT_OUTPUT")" \
      = root:root:700 ] \
    || die "pre-Docker preflight evidence directory identity is unsafe"
  for evidence_file in result.json runtime-authority.json; do
    validate_root_trusted_path \
      "$PRE_DOCKER_PREFLIGHT_OUTPUT/$evidence_file" \
      "pre-Docker preflight $evidence_file" file
    [ "$(stat -c '%U:%G:%a' \
        -- "$PRE_DOCKER_PREFLIGHT_OUTPUT/$evidence_file")" = root:root:600 ] \
      || die "pre-Docker preflight $evidence_file identity is unsafe"
  done
  /usr/bin/node - \
    "$PRE_DOCKER_PREFLIGHT_OUTPUT/result.json" \
    "$PRE_DOCKER_PREFLIGHT_OUTPUT/runtime-authority.json" <<'NODE' \
    || die "pre-Docker evidence does not prove Docker remained absent"
const fs = require('fs');
const [resultPath, authorityPath] = process.argv.slice(2);
const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
const authority = JSON.parse(fs.readFileSync(authorityPath, 'utf8'));
if (result?.schema !== 'nexus.sonarqube-host-preflight.v1'
    || result?.status !== 'passed'
    || result?.host !== 'serverdominguez'
    || result?.dockerEngineCaptured !== false
    || authority?.schema !== 'nexus.sonarqube-runtime-authority.v1'
    || authority?.status !== 'passed'
    || authority?.dockerAuthority !== 'not_installed'
    || authority?.dockerUserns !== null) process.exit(1);
NODE
  # Reopen every live absence signal after result.json exists and after all
  # evidence validation. A CLI/socket/config/package/unit/process that appeared
  # during the network/capacity sample invalidates the baseline.
  assert_pre_docker_absent_boundary post-capture
  result_sha256="$(
    sha256sum -- "$PRE_DOCKER_PREFLIGHT_OUTPUT/result.json" | cut -d' ' -f1
  )"
  printf '{"ok":true,"schema":"nexus.sonarqube-pre-docker-preflight.v1","sourceSha":"%s","archiveSha256":"%s","resultSha256":"%s","preflightOnly":true,"dockerTouched":false,"assetsInstalled":false,"configurationWritten":false}\n' \
    "$SOURCE_SHA" "$EXPECTED_ARCHIVE_SHA256" "$result_sha256"
  exit 0
fi

systemd-tmpfiles --create "$SHARED_MUTEX_CONFIG" \
  || die "shared release/Sonar mutex could not be materialized from its global rule"
[ -f "$SHARED_MUTEX" ] && [ ! -L "$SHARED_MUTEX" ] \
  && [ "$(stat -c '%U:%G:%a' -- "$SHARED_MUTEX")" = root:dominguez:660 ] \
  || die "shared release/Sonar mutex is unavailable after tmpfiles materialization"

if [ ! -e "$ANCHOR_UNENROLL_JOURNAL" ] \
    && [ ! -L "$ANCHOR_UNENROLL_JOURNAL" ] \
    && { [ -e "$ANCHOR_UNENROLL_RESULT" ] \
      || [ -L "$ANCHOR_UNENROLL_RESULT" ]; }; then
  [ -f "$SHARED_MUTEX" ] && [ ! -L "$SHARED_MUTEX" ] \
    && [ "$(stat -c '%U:%G:%a' -- "$SHARED_MUTEX")" = root:dominguez:660 ] \
    || die "shared release/Sonar mutex is unavailable for anchor cleanup"
  python3 "$SOURCE_ROOT/scripts/quality-sonar-install-transaction.py" \
    resume-anchor-cleanup \
    --result "$ANCHOR_UNENROLL_RESULT" \
    --lock "$SHARED_MUTEX" \
    || die "durable post-commit anchor cleanup could not be resumed"
  python3 "$SOURCE_ROOT/scripts/quality-sonar-install-transaction.py" \
    retire-anchor-cleanup-result \
    --result "$ANCHOR_UNENROLL_RESULT" \
    --archive "$ANCHOR_UNENROLL_ARCHIVE" \
    --lock "$SHARED_MUTEX" \
    || die "completed anchor cleanup evidence could not be archived"
fi

control_recovery_required=false
for control_marker in \
  "$INSTALL_JOURNAL" "$DIRECTORY_JOURNAL" "$RECOVERY_ANCHOR_INTENT" \
  "$ANCHOR_UNENROLL_JOURNAL"; do
  if [ -L "$control_marker" ]; then
    die "Sonar install control marker is a symlink: $control_marker"
  elif [ -e "$control_marker" ]; then
    [ -f "$control_marker" ] \
      && [ "$(stat -c '%U:%G:%a' -- "$control_marker")" = root:root:600 ] \
      || die "Sonar install control marker is unsafe: $control_marker"
    control_recovery_required=true
  fi
done
if [ "$control_recovery_required" = true ] \
    && [ -f "$INSTALL_RECOVERY_PROGRAM" ]; then
  [ ! -L "$INSTALL_RECOVERY_PROGRAM" ] \
    && [ "$(realpath -e -- "$INSTALL_RECOVERY_PROGRAM")" = "$INSTALL_RECOVERY_PROGRAM" ] \
    && [ "$(stat -c '%U:%G:%a' -- "$INSTALL_RECOVERY_PROGRAM")" = root:root:600 ] \
    || die "unfinished installation requires its exact retained recovery program"
  [ -f "$SHARED_MUTEX" ] && [ ! -L "$SHARED_MUTEX" ] \
    && [ "$(stat -c '%U:%G:%a' -- "$SHARED_MUTEX")" = root:dominguez:660 ] \
    || die "shared release/Sonar mutex is unavailable for install recovery"
  python3 "$INSTALL_RECOVERY_PROGRAM" auto-recover \
    --program "$INSTALL_RECOVERY_PROGRAM" \
    --lock "$SHARED_MUTEX" \
    --asset-journal "$INSTALL_JOURNAL" \
    --asset-receipt "$INSTALL_RECOVERY_RECEIPT" \
    --directory-journal "$DIRECTORY_JOURNAL" \
    --directory-receipt "$DIRECTORY_RECOVERY_RECEIPT" \
    --anchor-intent "$RECOVERY_ANCHOR_INTENT" \
    --anchor-receipt "$RECOVERY_ANCHOR_RECEIPT" \
    --unenroll-journal "$ANCHOR_UNENROLL_JOURNAL" \
    --unenroll-result "$ANCHOR_UNENROLL_RESULT" \
    --install-commit "$INSTALL_COMMIT"
  die "recovered interrupted Sonar installation state; review evidence and rerun"
elif [ "$control_recovery_required" = true ] \
    && { [ -e "$INSTALL_JOURNAL" ] || [ -e "$DIRECTORY_JOURNAL" ] \
      || [ -e "$ANCHOR_UNENROLL_JOURNAL" ]; }; then
  die "unfinished Sonar installation lacks its retained recovery program"
fi

# Docker must be installed fresh with daemon-wide userns-remap before the
# installer can safely materialize writable bind directories. Resolve the live
# subordinate ranges from the already archive-verified source verifier; never
# assume that container UID/GID 999 or 1000 is unused on the host.
userns_map_json="$(
  bash "$SOURCE_ROOT/scripts/quality-sonar-preflight.sh" --print-userns-map
)" || die "live Docker user-namespace mapping rejected Sonar asset installation"
IFS=$'\t' read -r mapped_postgres_owner mapped_sonar_owner < <(
  /usr/bin/node - "$userns_map_json" <<'NODE'
const value = JSON.parse(process.argv[2]);
if (value?.schema !== 'nexus.docker-userns-map.v1'
    || value?.status !== 'passed'
    || value?.postgres?.hostUid !== value.subuidBase + 999
    || value?.postgres?.hostGid !== value.subgidBase + 999
    || value?.sonarqube?.hostUid !== value.subuidBase + 1000
    || value?.sonarqube?.hostGid !== value.subgidBase + 1000) process.exit(1);
process.stdout.write(
  `${value.postgres.hostUid}:${value.postgres.hostGid}\t`
  + `${value.sonarqube.hostUid}:${value.sonarqube.hostGid}\n`,
);
NODE
) || die "Docker user-namespace mapping output is malformed"
[[ "$mapped_postgres_owner" =~ ^[0-9]+:[0-9]+$ ]] \
  && [[ "$mapped_sonar_owner" =~ ^[0-9]+:[0-9]+$ ]] \
  || die "Docker user-namespace mapped owners are malformed"
userns_map_sha256="$(
  printf '%s' "$userns_map_json" | sha256sum | cut -d' ' -f1
)"
[[ "$userns_map_sha256" =~ ^[0-9a-f]{64}$ ]] \
  || die "Docker user-namespace mapping digest is malformed"

sources=()
targets=()
owners=()
groups=()
modes=()
had_targets=()
declare -A seen_sources=()
declare -A seen_targets=()
service_index=-1
recovery_program_index=-1
recovery_service_index=-1

while IFS=$'\t' read -r relative target owner mode extra; do
  [ -z "$extra" ] || die "install layout contains an extra column"
  [ -n "$relative" ] && [ -n "$target" ] && [ -n "$owner" ] && [ -n "$mode" ] \
    || die "install layout contains an incomplete row"
  [[ "$relative" =~ ^[A-Za-z0-9._@/-]+$ ]] \
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
    /etc/systemd/system/nexus-sonarqube-install-recovery.service|\
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
    /usr/local/sbin/quality-sonar-stack-receipt.mjs|\
    /usr/local/sbin/quality-sonar-aws-stack-state|\
    /usr/local/sbin/quality-sonar-cloudformation-activate|\
    /usr/local/sbin/quality-sonar-release-state|\
    /usr/local/sbin/quality-sonar-install-transaction.py|\
    /etc/sudoers.d/nexus-sonar-release-monitor) ;;
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
  if [ "$target" = "/usr/local/sbin/quality-sonar-install-transaction.py" ]; then
    recovery_program_index=$((${#targets[@]} - 1))
  fi
  if [ "$target" = "/etc/systemd/system/$INSTALL_RECOVERY_SERVICE" ]; then
    recovery_service_index=$((${#targets[@]} - 1))
  fi
done <<< "$actual_layout"

planned="${#sources[@]}"
[ "$planned" -gt 0 ] || die "install layout is empty"
[ "$service_index" -ge 0 ] || die "install layout omits the journal-guarded Sonar service"
[ "$recovery_program_index" -ge 0 ] \
  || die "install layout omits the retained recovery program"
[ "$recovery_service_index" -ge 0 ] \
  || die "install layout omits the boot recovery service"

data_paths=()
data_owners=()
data_groups=()
data_modes=()
while IFS=$'\t' read -r path numeric_owner mode purpose extra; do
  host_owner=""
  [ -z "$extra" ] || die "data layout contains an extra column"
  [ -n "$path" ] && [ -n "$numeric_owner" ] && [ -n "$mode" ] && [ -n "$purpose" ] \
    || die "data layout contains an incomplete row"
  [[ "$path" == /srv/sonarqube || "$path" == /srv/sonarqube/data || "$path" == /srv/sonarqube/data/* ]] \
    && [ "$(realpath -m -- "$path")" = "$path" ] \
    || die "data layout path is outside the exact allowlist"
  [[ "$numeric_owner" =~ ^[0-9]+:[0-9]+$ ]] \
    || die "data layout owner must be numeric"
  case "$numeric_owner" in
    0:0) host_owner=0:0 ;;
    999:999) host_owner="$mapped_postgres_owner" ;;
    1000:1000) host_owner="$mapped_sonar_owner" ;;
    *) die "data layout container owner is outside the exact allowlist" ;;
  esac
  case "$mode" in 0700|0750) ;; *) die "data layout mode is outside the allowlist" ;; esac
  validate_existing_target_ancestor "$(dirname -- "$path")"
  if [ -L "$path" ]; then
    die "existing Sonar directory is a symlink: $path"
  elif [ -e "$path" ]; then
    [ -d "$path" ] || die "existing Sonar directory is not a directory: $path"
    [ "$(realpath -e -- "$path")" = "$path" ] \
      || die "existing Sonar directory traverses a symlink: $path"
    [ "$(stat -c '%u:%g' -- "$path")" = "$host_owner" ] \
      || die "existing Sonar directory owner differs from the mapped data layout: $path"
    [ "$(stat -c '%a' -- "$path")" = "${mode#0}" ] \
      || die "existing Sonar directory mode differs from the data layout: $path"
  fi
  IFS=: read -r numeric_uid numeric_gid <<< "$host_owner"
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
validate_managed_directory "$CONTROL_PARENT" root root 0755
validate_managed_directory "$CONTROL_ROOT" root root 0700
validate_managed_directory "$STATE_DIR" root root 0700
validate_managed_directory "$RESTORE_EVIDENCE_DIR" root root 0700
[ -d "$CONTROL_PARENT" ] && [ ! -L "$CONTROL_PARENT" ] \
  && [ "$(realpath -e -- "$CONTROL_PARENT")" = "$CONTROL_PARENT" ] \
  || die "root promotion state must preexist before Sonar control enrollment"

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
    *.py)
      python3 -c \
        'import pathlib,sys; compile(pathlib.Path(sys.argv[1]).read_bytes(), sys.argv[1], "exec")' \
        "$source_path"
      ;;
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

# This live, read-only gate precedes the first managed-directory creation or
# target staging operation. Docker, its user-namespace map, the protected host
# identities, mapped bind identities, systemd updater inventory, memory, load,
# swap, recent OOM state, and four-process PM2 stability must all be safe.
# Interrupted-install recovery above remains available regardless of capacity.
bash "$SOURCE_ROOT/scripts/quality-sonar-preflight.sh" \
  --verify-runtime-boundary-only \
  --sample-seconds 1 >/dev/null \
  || die "live pre-install runtime boundary rejected Sonar asset installation"

# The external control root is a separate, harmless prerequisite. Its intent
# is persisted in the already boot-recoverable release state before the only
# mkdir in this bootstrap phase.
python3 "${sources[$recovery_program_index]}" bootstrap-control-root \
  --parent "$CONTROL_PARENT" \
  --root "$CONTROL_ROOT" \
  --intent "$CONTROL_ROOT_INTENT" \
  --receipt "$CONTROL_ROOT_RECEIPT" \
  --source-sha "$SOURCE_SHA" \
  --archive-sha256 "$EXPECTED_ARCHIVE_SHA256"

stage_paths=()
backup_paths=()
receipt_assets=""
transaction_dir=""
transaction_plan=""
directory_plan=""
journal_armed=false
directory_armed=false
install_succeeded=false
lock_open=true

cleanup_install() {
  local rc=$? stage backup recovery_failed=false
  trap - EXIT INT TERM
  set +e
  if [ "$install_succeeded" != true ] \
      && { [ -e "$INSTALL_JOURNAL" ] || [ -e "$DIRECTORY_JOURNAL" ]; }; then
    if [ "$lock_open" = true ]; then
      exec 9>&-
      lock_open=false
    fi
    if python3 "$INSTALL_RECOVERY_PROGRAM" auto-recover \
        --program "$INSTALL_RECOVERY_PROGRAM" \
        --lock "$SHARED_MUTEX" \
        --asset-journal "$INSTALL_JOURNAL" \
        --asset-receipt "$INSTALL_RECOVERY_RECEIPT" \
        --directory-journal "$DIRECTORY_JOURNAL" \
        --directory-receipt "$DIRECTORY_RECOVERY_RECEIPT" \
        --anchor-intent "$RECOVERY_ANCHOR_INTENT" \
        --anchor-receipt "$RECOVERY_ANCHOR_RECEIPT" \
        --unenroll-journal "$ANCHOR_UNENROLL_JOURNAL" \
        --unenroll-result "$ANCHOR_UNENROLL_RESULT" \
        --install-commit "$INSTALL_COMMIT"; then
      journal_armed=false
      directory_armed=false
      stage_paths=()
      backup_paths=()
      transaction_dir=""
      transaction_plan=""
      directory_plan=""
    else
      recovery_failed=true
      echo "SonarQube asset installer: exact recovery failed; control journals retained for boot recovery" >&2
    fi
  fi

  if [ "$lock_open" = true ]; then
    exec 9>&-
    lock_open=false
  fi
  if [ "$journal_armed" = false ] \
      && [ "$directory_armed" = false ] \
      && [ "$install_succeeded" != true ]; then
    [ -z "$receipt_assets" ] || durable_remove "$receipt_assets"
    for stage in "${stage_paths[@]:-}"; do
      [ -z "$stage" ] || durable_remove "$stage"
    done
    for backup in "${backup_paths[@]:-}"; do
      [ -z "$backup" ] || durable_remove "$backup"
    done
    if [ -n "$transaction_plan" ]; then
      durable_remove "$transaction_plan"
    fi
    if [ -n "$directory_plan" ]; then
      durable_remove "$directory_plan"
    fi
    if [ -n "$transaction_dir" ]; then
      rmdir -- "$transaction_dir" >/dev/null 2>&1 || true
    fi
  fi
  if [ "$recovery_failed" = true ]; then
    rc=1
  fi
  exit "$rc"
}
trap cleanup_install EXIT
trap 'exit 130' INT TERM

# Enroll the boot-recovery anchors before the first managed Sonar directory.
# The helper writes its external intent before creating any absent anchor and
# resumes an interrupted enrollment from the same exact source/archive binding.
python3 "${sources[$recovery_program_index]}" enroll-anchors \
  --intent "$RECOVERY_ANCHOR_INTENT" \
  --receipt "$RECOVERY_ANCHOR_RECEIPT" \
  --source-root "$SOURCE_ROOT" \
  --source-sha "$SOURCE_SHA" \
  --archive-sha256 "$EXPECTED_ARCHIVE_SHA256"
[ -f "$INSTALL_RECOVERY_PROGRAM" ] && [ ! -L "$INSTALL_RECOVERY_PROGRAM" ] \
  && [ "$(stat -c '%U:%G:%a' -- "$INSTALL_RECOVERY_PROGRAM")" = root:root:600 ] \
  || die "recovery-anchor enrollment did not retain its exact program"
had_targets[$recovery_program_index]=true
had_targets[$recovery_service_index]=true

# Reopen the exact derived Docker mapping immediately before the directory
# transaction. A concurrent root remap cannot make the earlier high-ID
# calculation stale.
fresh_userns_map_json="$(
  bash "$SOURCE_ROOT/scripts/quality-sonar-preflight.sh" --print-userns-map
)" || die "live Docker user-namespace mapping changed before directory mutation"
fresh_userns_map_sha256="$(
  printf '%s' "$fresh_userns_map_json" | sha256sum | cut -d' ' -f1
)"
[ "$fresh_userns_map_json" = "$userns_map_json" ] \
  && [ "$fresh_userns_map_sha256" = "$userns_map_sha256" ] \
  || die "Docker user-namespace mapping receipt drifted before directory mutation"

install_transaction_id="$(
  python3 -c 'import secrets; print(secrets.token_hex(32))'
)"
[[ "$install_transaction_id" =~ ^[0-9a-f]{64}$ ]] \
  || die "could not create a unique Sonar install transaction identity"

directory_plan="$(mktemp -p "$CONTROL_ROOT" ".directory-plan.XXXXXX")"
chmod 0600 "$directory_plan"
append_directory_plan() {
  local index="$1" path="$2" uid="$3" gid="$4" mode="$5"
  local had=false predecessor_uid=- predecessor_gid=- predecessor_mode=-
  local predecessor_dev=- predecessor_ino=-
  if [ -e "$path" ]; then
    [ -d "$path" ] && [ ! -L "$path" ] \
      && [ "$(realpath -e -- "$path")" = "$path" ] \
      || die "directory predecessor is unsafe: $path"
    [ "$(stat -c '%u:%g' -- "$path")" = "$uid:$gid" ] \
      && [ "0$(stat -c '%a' -- "$path")" = "$mode" ] \
      || die "directory predecessor identity drifted: $path"
    had=true
    predecessor_uid="$(stat -c '%u' -- "$path")"
    predecessor_gid="$(stat -c '%g' -- "$path")"
    predecessor_mode="0$(stat -c '%a' -- "$path")"
    predecessor_dev="$(stat -c '%d' -- "$path")"
    predecessor_ino="$(stat -c '%i' -- "$path")"
  fi
  printf '%d\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$index" "$path" "$uid" "$gid" "$mode" "$had" \
    "$predecessor_uid" "$predecessor_gid" "$predecessor_mode" \
    "$predecessor_dev" "$predecessor_ino" >>"$directory_plan"
}

append_directory_plan 0 /usr/local/sbin/lib 0 0 0755
append_directory_plan 1 /etc/systemd/system/ollama.service.d 0 0 0755
append_directory_plan 2 /etc/sonarqube 0 0 0700
append_directory_plan 3 "$STATE_DIR" 0 0 0700
append_directory_plan 4 "$RESTORE_EVIDENCE_DIR" 0 0 0700
for ((index=0; index<${#data_paths[@]}; index+=1)); do
  append_directory_plan \
    "$((index + 5))" \
    "${data_paths[$index]}" \
    "${data_owners[$index]}" \
    "${data_groups[$index]}" \
    "${data_modes[$index]}"
done
fsync_path "$directory_plan"
fsync_path "$CONTROL_ROOT"

python3 "$INSTALL_RECOVERY_PROGRAM" begin-directories \
  --journal "$DIRECTORY_JOURNAL" \
  --plan "$directory_plan" \
  --program "$INSTALL_RECOVERY_PROGRAM" \
  --install-transaction-id "$install_transaction_id" \
  --source-sha "$SOURCE_SHA" \
  --archive-sha256 "$EXPECTED_ARCHIVE_SHA256" \
  --userns-map-sha256 "$userns_map_sha256"
directory_armed=true
for ((index=0; index<5+${#data_paths[@]}; index+=1)); do
  python3 "$INSTALL_RECOVERY_PROGRAM" create-directory \
    --journal "$DIRECTORY_JOURNAL" \
    --program "$INSTALL_RECOVERY_PROGRAM" \
    --index "$index"
done

# Stage every asset and bind every predecessor before the journal. Stages and
# hard-link backups do not mutate a live target. Once the journal exists, its
# complete inventory is sufficient for recovery without shell memory.
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
  if [ "${had_targets[$index]}" = true ]; then
    backup="$(mktemp -p "$target_parent" ".nexus-sonarqube.backup.XXXXXX")"
    rm -f -- "$backup"
    ln -- "$target" "$backup"
    fsync_path "$target_parent"
    backup_paths[$index]="$backup"
  fi
done

receipt_assets="$(mktemp -p "$STATE_DIR" ".install-assets.XXXXXX")"
for ((index=0; index<planned; index+=1)); do
  printf '%s\t%s\t%s:%s\t%s\n' \
    "${targets[$index]}" \
    "$(sha256sum -- "${stage_paths[$index]}" | cut -d' ' -f1)" \
    "${owners[$index]}" "${groups[$index]}" "${modes[$index]}" \
    >>"$receipt_assets"
done
chmod 0600 "$receipt_assets"
current_lock_identity="$(
  stat -c '%u:%g:0%a:%d:%i:%h' -- "$SHARED_MUTEX_CONFIG"
)"
[ "$current_lock_identity" = \
    "$SHARED_MUTEX_CONFIG_UID:$SHARED_MUTEX_CONFIG_GID:$SHARED_MUTEX_CONFIG_MODE:$SHARED_MUTEX_CONFIG_DEV:$SHARED_MUTEX_CONFIG_INO:$SHARED_MUTEX_CONFIG_NLINK" ] \
  && [ "$(sha256sum -- "$SHARED_MUTEX_CONFIG" | cut -d' ' -f1)" = \
    "$SHARED_MUTEX_CONFIG_SHA256" ] \
  || die "promotion-owned shared lock config changed before receipt staging"
receipt_index="$planned"
receipt_stage="$(mktemp -p "$STATE_DIR" ".nexus-sonarqube.stage.XXXXXX")"
python3 - \
  "$SOURCE_SHA" "$EXPECTED_ARCHIVE_SHA256" "$receipt_assets" \
  "$receipt_stage" "$SHARED_MUTEX_CONFIG" "$SHARED_MUTEX_CONFIG_SHA256" \
  "$SHARED_MUTEX_CONFIG_UID" "$SHARED_MUTEX_CONFIG_GID" \
  "$SHARED_MUTEX_CONFIG_MODE" "$SHARED_MUTEX_CONFIG_DEV" \
  "$SHARED_MUTEX_CONFIG_INO" "$SHARED_MUTEX_CONFIG_NLINK" <<'PY'
import datetime
import json
import pathlib
import sys

(
    source_sha,
    archive_sha256,
    assets_path,
    output_path,
    dependency_target,
    dependency_sha256,
    dependency_uid,
    dependency_gid,
    dependency_mode,
    dependency_dev,
    dependency_ino,
    dependency_nlink,
) = sys.argv[1:]
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
    "preservedDependencies": [{
        "name": "releaseSonarLockConfig",
        "target": dependency_target,
        "sha256": dependency_sha256,
        "uid": int(dependency_uid),
        "gid": int(dependency_gid),
        "mode": dependency_mode,
        "dev": int(dependency_dev),
        "ino": int(dependency_ino),
        "nlink": int(dependency_nlink),
    }],
    "configurationWritten": False,
    "dockerTouched": False,
    "servicesEnabled": False,
    "installRecoveryServiceEnabled": True,
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
targets[$receipt_index]="$INSTALL_RECEIPT"
owners[$receipt_index]=root
groups[$receipt_index]=root
modes[$receipt_index]=0600
stage_paths[$receipt_index]="$receipt_stage"
backup_paths[$receipt_index]=""
had_targets[$receipt_index]=false
if [ -e "$INSTALL_RECEIPT" ]; then
  had_targets[$receipt_index]=true
  receipt_backup="$(
    mktemp -p "$STATE_DIR" ".nexus-sonarqube.backup.XXXXXX"
  )"
  rm -f -- "$receipt_backup"
  ln -- "$INSTALL_RECEIPT" "$receipt_backup"
  fsync_path "$STATE_DIR"
  backup_paths[$receipt_index]="$receipt_backup"
fi
total_planned=$((planned + 1))

transaction_dir="$(mktemp -d -p "$CONTROL_ROOT" ".install-transaction.v2.XXXXXX")"
chmod 0700 "$transaction_dir"
transaction_plan="$transaction_dir/plan.tsv"
: >"$transaction_plan"
chmod 0600 "$transaction_plan"
for ((index=0; index<total_planned; index+=1)); do
  target="${targets[$index]}"
  stage="${stage_paths[$index]}"
  backup="${backup_paths[$index]:-}"
  kind=layout
  [ "$index" -ne "$receipt_index" ] || kind=receipt
  predecessor_sha=-
  predecessor_uid=-
  predecessor_gid=-
  predecessor_mode=-
  backup_field=-
  if [ "${had_targets[$index]}" = true ]; then
    backup_field="$backup"
    predecessor_sha="$(sha256sum -- "$backup" | cut -d' ' -f1)"
    predecessor_uid="$(stat -c '%u' -- "$backup")"
    predecessor_gid="$(stat -c '%g' -- "$backup")"
    predecessor_mode="0$(stat -c '%a' -- "$backup")"
  fi
  printf '%d\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$index" "$kind" "$target" "$stage" "$backup_field" \
    "${had_targets[$index]}" \
    "$(sha256sum -- "$stage" | cut -d' ' -f1)" \
    "$(stat -c '%u' -- "$stage")" "$(stat -c '%g' -- "$stage")" \
    "${modes[$index]}" "$predecessor_sha" "$predecessor_uid" \
    "$predecessor_gid" "$predecessor_mode" >>"$transaction_plan"
done
fsync_path "$transaction_plan"
fsync_path "$transaction_dir"

python3 "$INSTALL_RECOVERY_PROGRAM" begin \
  --journal "$INSTALL_JOURNAL" \
  --plan "$transaction_plan" \
  --program "$INSTALL_RECOVERY_PROGRAM" \
  --install-transaction-id "$install_transaction_id" \
  --source-sha "$SOURCE_SHA" \
  --archive-sha256 "$EXPECTED_ARCHIVE_SHA256"
journal_armed=true

commit_asset() {
  local index="$1" target target_parent
  target="${targets[$index]}"
  target_parent="$(dirname -- "$target")"
  mv -fT -- "${stage_paths[$index]}" "$target"
  fsync_path "$target_parent"
  python3 "$INSTALL_RECOVERY_PROGRAM" checkpoint \
    --journal "$INSTALL_JOURNAL" \
    --program "$INSTALL_RECOVERY_PROGRAM" \
    --phase "committed-$index" \
    --committed-index "$index"
}

# Commit the journal-aware runtime service first. A reboot during the remaining
# replacements reloads this unit from disk and refuses Sonar startup until the
# enabled recovery unit has restored every predecessor.
commit_asset "$service_index"
for ((index=0; index<planned; index+=1)); do
  [ "$index" -eq "$service_index" ] && continue
  commit_asset "$index"
done
commit_asset "$receipt_index"

systemctl daemon-reload
systemd-analyze verify \
  /etc/systemd/system/nexus-sonarqube.service \
  /etc/systemd/system/nexus-sonarqube-backup.service \
  /etc/systemd/system/nexus-sonarqube-backup.timer \
  /etc/systemd/system/nexus-sonarqube-install-recovery.service \
  /etc/systemd/system/nexus-ollama-observation@.service >/dev/null
systemd-tmpfiles --create /etc/tmpfiles.d/nexus-release-sonar-lock.conf
[ -f "$SHARED_MUTEX" ] && [ ! -L "$SHARED_MUTEX" ] \
  && [ "$(stat -c '%U:%G:%a' -- "$SHARED_MUTEX")" = root:dominguez:660 ] \
  || die "shared release/Sonar mutex changed during installation"
assert_units_untouched_and_disabled
[ "$(unit_state "$INSTALL_RECOVERY_SERVICE")" = enabled ] \
  || die "Sonar install recovery service lost its durable enablement"

python3 "$INSTALL_RECOVERY_PROGRAM" commit-install \
  --asset-journal "$INSTALL_JOURNAL" \
  --directory-journal "$DIRECTORY_JOURNAL" \
  --program "$INSTALL_RECOVERY_PROGRAM" \
  --marker "$INSTALL_COMMIT"
journal_armed=false
directory_armed=false
install_succeeded=true

printf '{"ok":true,"schema":"nexus.sonarqube-asset-install.v1","sourceSha":"%s","archiveSha256":"%s","installedAssets":%d,"configurationWritten":false,"dockerTouched":false,"servicesEnabled":false,"installRecoveryServiceEnabled":true,"applicationDataWritten":false}\n' \
  "$SOURCE_SHA" "$EXPECTED_ARCHIVE_SHA256" "$planned"
