#!/usr/bin/env bash
# Retire only the audited legacy release machinery after the first lean
# production proof. The default is a read-only plan; apply requires the exact
# production SHA/digest and the normal production-owner authorization flag.
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

MODE=dry-run
CONFIRMATION=
SCRIPT_SOURCED=false
[ "${BASH_SOURCE[0]}" = "$0" ] || SCRIPT_SOURCED=true
if [ "$SCRIPT_SOURCED" = false ]; then
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --apply)
        MODE=apply
        shift
        ;;
      --confirm)
        [ "$#" -ge 2 ] || {
          echo "retire legacy release machinery: --confirm requires SHA:DIGEST" >&2
          exit 64
        }
        CONFIRMATION="$2"
        shift 2
        ;;
      *)
        echo "usage: sudo scripts/retire-legacy-release-machinery.sh [--apply --confirm <sha>:<digest>]" >&2
        exit 64
        ;;
    esac
  done

  [ "$(id -u)" -eq 0 ] || {
    echo "retire legacy release machinery: root is required" >&2
    exit 77
  }
  if [ "$MODE" = apply ]; then
    [ "${NEXUS_RELEASE_OWNER_AUTHORIZED:-}" = 1 ] || {
      echo "retire legacy release machinery: NEXUS_RELEASE_OWNER_AUTHORIZED=1 is required" >&2
      exit 77
    }
    [[ "$CONFIRMATION" =~ ^[0-9a-f]{40}:[0-9a-f]{64}$ ]] || {
      echo "retire legacy release machinery: apply requires exact SHA:DIGEST confirmation" >&2
      exit 64
    }
  elif [ -n "$CONFIRMATION" ] && [[ ! "$CONFIRMATION" =~ ^[0-9a-f]{40}:[0-9a-f]{64}$ ]]; then
    echo "retire legacy release machinery: confirmation is malformed" >&2
    exit 64
  fi
fi

DEPLOY_HOME="${NEXUS_RELEASE_DEPLOY_HOME:-}"
[ -n "$DEPLOY_HOME" ] || {
  echo "retire legacy release machinery: NEXUS_RELEASE_DEPLOY_HOME is required" >&2
  exit 1
}
PRODUCTION_BASE="$DEPLOY_HOME/telegram-hub-bot"
CURRENT_LINK="$PRODUCTION_BASE/current"
STAGING_BASE="$DEPLOY_HOME/telegram-hub-bot-staging"
STAGING_CURRENT_LINK="$STAGING_BASE/current"
STATE_FILE="$DEPLOY_HOME/.local/state/nexus-release/production.json"
PM2_HOME="$DEPLOY_HOME/.pm2"
PM2_DUMP="$PM2_HOME/dump.pm2"
PM2_BIN=/usr/local/bin/pm2
NODE_BIN=/usr/bin/node
SYSTEMCTL_BIN=/usr/bin/systemctl
CURL_BIN=/usr/bin/curl
RUNUSER_BIN=/usr/sbin/runuser
TIMEOUT_BIN=/usr/bin/timeout
FLOCK_BIN=/usr/bin/flock
STAT_BIN=/usr/bin/stat
CMP_BIN=/usr/bin/cmp
DIFF_BIN=/usr/bin/diff
GETENT_BIN=/usr/bin/getent
ID_BIN=/usr/bin/id
PGREP_BIN=/usr/bin/pgrep
FIND_BIN=/usr/bin/find
USERDEL_BIN=/usr/sbin/userdel
GROUPDEL_BIN=/usr/sbin/groupdel
TEMPORARY_PM2_UNIT=nexus-release-pm2-recovery-daemon.service
CANONICAL_PM2_UNIT=pm2-dominguez.service
CANONICAL_PM2_EXEC="$DEPLOY_HOME/.npm-global/lib/node_modules/pm2/bin/pm2"
CANONICAL_PM2_UNIT_FILE=/etc/systemd/system/pm2-dominguez.service
USER_RELEASE_LOCK="$DEPLOY_HOME/.local/state/nexus-release/.release.lock"
ROOT_SONAR_LOCK=/run/lock/nexus-release-sonar.lock
SELF_CGROUP_FILE=/proc/self/cgroup
PM2_AUTHORITY_UNIT=
PM2_AUTHORITY_PID=
PM2_AUTHORITY_CGROUP=
PM2_BLOCKER_BACKUP=
PM2_BLOCKER_BACKUP_ROOT=/var/lib/nexus-release-retirement
PM2_BLOCKER_GUARD_ARMED=false
HEALTH_HTTP_TIMEOUT_SECONDS=3
PM2_SNAPSHOT_TIMEOUT_SECONDS=5
PM2_HANDOFF_HEALTH_BUDGET_SECONDS=15
SERVICE_CONTROL_TIMEOUT_SECONDS=10
PM2_RESURRECT_TIMEOUT_SECONDS=10
RETIRED_KVM_USER=nexus-drill-vm
RETIRED_KVM_UID=993
RETIRED_KVM_GROUP=nexus-drill-vm
RETIRED_KVM_GID=980
RETIRED_KVM_SUPPLEMENTARY_GROUP=kvm
RETIRED_KVM_SUPPLEMENTARY_GID=993
RETIRED_KVM_PASSWD_ENTRY='nexus-drill-vm:x:993:980::/nonexistent:/usr/sbin/nologin'
RETIRED_KVM_GROUP_ENTRY='nexus-drill-vm:x:980:'
RETIRED_KVM_RUNTIME_ROOT=/run/nexus-rollback-drill-vm
RETIRED_KVM_IDENTITY_PRESENT=false
RETIRED_KVM_ORPHAN_GROUP_PRESENT=false
GETENT_RESULT=
GETENT_FOUND=false

LEGACY_DROP_INS=(
  /etc/systemd/system/pm2-dominguez.service.d/00-nexus-release-layout-install-recovery.conf
  /etc/systemd/system/pm2-dominguez.service.d/10-nexus-rollback-drill-legacy-staging-recovery.conf
  /etc/systemd/system/pm2-dominguez.service.d/15-nexus-rollback-drill-v4-prelayout-staging-recovery.conf
  /etc/systemd/system/pm2-dominguez.service.d/nexus-release-recovery.conf
  /etc/systemd/system/pm2-root.service.d/10-nexus-rollback-drill-legacy-staging-recovery.conf
  /etc/systemd/system/pm2-root.service.d/15-nexus-rollback-drill-v4-prelayout-staging-recovery.conf
  /etc/systemd/system/pm2-root.service.d/nexus-release-recovery.conf
  /etc/systemd/system/nexus-release-promotion-recovery.service.d/15-nexus-rollback-drill-v4-prelayout-promotion-recovery.conf
  /etc/systemd/system/nexus-cloudflared.service.d/nexus-release-ready.conf
)

LEGACY_DEPENDENCY_LINKS=(
  /etc/systemd/system/pm2-dominguez.service.requires/nexus-rollback-drill-legacy-staging-install-recovery.service
  /etc/systemd/system/pm2-dominguez.service.requires/nexus-rollback-drill-legacy-staging-recovery.service
  /etc/systemd/system/pm2-dominguez.service.requires/nexus-rollback-drill-v4-prelayout-staging-install-recovery.service
  /etc/systemd/system/pm2-dominguez.service.requires/nexus-rollback-drill-v4-prelayout-staging-recovery.service
  /etc/systemd/system/pm2-root.service.requires/nexus-rollback-drill-legacy-staging-install-recovery.service
  /etc/systemd/system/pm2-root.service.requires/nexus-rollback-drill-legacy-staging-recovery.service
  /etc/systemd/system/pm2-root.service.requires/nexus-rollback-drill-v4-prelayout-staging-install-recovery.service
  /etc/systemd/system/pm2-root.service.requires/nexus-rollback-drill-v4-prelayout-staging-recovery.service
)

LEGACY_UNITS=(
  nexus-release-layout-activation@.service
  nexus-release-layout-fault-drill-recovery.service
  nexus-release-layout-fault-drill@.service
  nexus-release-layout-install-recovery.service
  nexus-release-layout-recovery.service
  nexus-release-pm2-recovery-daemon.service
  nexus-release-promotion-recovery.service
  nexus-release-promotion@.service
  nexus-rollback-drill-v4-prelayout-staging-install-recovery.service
  nexus-rollback-drill-v4-prelayout-staging-recovery.service
  nexus-rollback-drill-v4-prelayout-staging@.service
  nexus-rollback-drill-vm@.service
)

LEGACY_HELPERS=(
  /etc/systemd/system/nexus-release-layout-fault-drill-recovery.service.d
  /etc/systemd/system/nexus-release-layout-fault-drill@.service.d
  /etc/systemd/system/nexus-rollback-drill-vm@.service.d
  /etc/tmpfiles.d/nexus-rollback-drill-vm.conf
  /usr/local/sbin/nexus-release-boot-health
  /usr/local/sbin/nexus-release-layout-activation-control
  /usr/local/sbin/nexus-release-layout-activation-install
  /usr/local/sbin/nexus-release-layout-migrate
  /usr/local/sbin/nexus-release-promotion-control
  /usr/local/sbin/nexus-release-promotion-worker-control
  /usr/local/sbin/nexus-rollback-drill-v4-prelayout-staging-broker
  /usr/local/sbin/nexus-rollback-drill-v4-prelayout-staging-install
  /usr/local/libexec/nexus-capture-pm2-dump-authority.mjs
  /usr/local/libexec/nexus-pm2-dump-authority.py
  /usr/local/libexec/nexus-promotion-authorization.mjs
  /usr/local/libexec/nexus-release-layout-authorization.mjs
  /usr/local/libexec/nexus-release-layout-fault-drill.mjs
  /usr/local/libexec/nexus-release-layout-preflight.sh
  /usr/local/libexec/nexus-release-layout-sqlite.py
  /usr/local/libexec/nexus-release-promotion-transaction
  /usr/local/libexec/nexus-release-selector-switch.py
  /usr/local/libexec/nexus-rollback-drill-v4-prelayout-installed-tree-attestation.mjs
  /usr/local/libexec/nexus-rollback-drill-v4-prelayout-recovery-runtime-identity.mjs
  /usr/local/libexec/nexus-rollback-drill-v4-prelayout-runtime-dependencies.mjs
  /usr/local/libexec/nexus-rollback-drill-v4-prelayout-staging-adapter.mjs
  /usr/local/libexec/nexus-rollback-drill-v4-prelayout-staging-fs.py
  /usr/local/libexec/nexus-rollback-drill-vm
  /usr/local/libexec/nexus-staging-attestation-broker.sh
  /usr/local/libexec/nexus-trusted-release-filesystem-identity.mjs
  /usr/local/libexec/nexus-trusted-release-runtime-attestation.mjs
  /etc/sudoers.d/nexus-release-promotion
  /etc/sudoers.d/nexus-release-layout-activation
  /etc/sudoers.d/nexus-rollback-drill-legacy-staging
  /etc/sudoers.d/nexus-rollback-drill-v4-prelayout-staging
)

LEGACY_STATE=(
  /etc/nexus-rollback-drill-vm
  /run/nexus-rollback-drill-vm
  /etc/nexus-release
  /srv/nexus-release
  /var/lib/nexus-release-bootstrap
  /var/lib/nexus-release-promotion
  /var/lib/nexus-rollback-drill-legacy-staging
  /var/lib/nexus-rollback-drill-v4-prelayout-staging
  /var/lib/nexus-rollback-drill-vm
)

die() {
  echo "retire legacy release machinery: $*" >&2
  exit 1
}

assert_safe_lock_file() {
  local lock_path="$1"
  local expected_identity="$2"
  [ -f "$lock_path" ] && [ ! -L "$lock_path" ] \
    && [ "$("$STAT_BIN" -c '%U:%G:%a' -- "$lock_path")" = "$expected_identity" ] \
    || die "shared lock is missing or unsafe: $lock_path"
}

assert_lock_fd_matches_path() {
  local descriptor="$1"
  local lock_path="$2"
  local path_identity descriptor_identity
  path_identity="$("$STAT_BIN" -Lc '%d:%i' -- "$lock_path")" \
    || die "cannot identify shared lock path: $lock_path"
  descriptor_identity="$("$STAT_BIN" -Lc '%d:%i' -- "/proc/$$/fd/$descriptor")" \
    || die "cannot identify shared lock descriptor: $lock_path"
  [ "$path_identity" = "$descriptor_identity" ] \
    || die "shared lock changed while it was opened: $lock_path"
}

acquire_retirement_locks() {
  # Keep the same order as lean staging/promotion and the Sonar scanner.
  assert_safe_lock_file "$USER_RELEASE_LOCK" dominguez:dominguez:600
  exec 9<>"$USER_RELEASE_LOCK"
  assert_safe_lock_file "$USER_RELEASE_LOCK" dominguez:dominguez:600
  assert_lock_fd_matches_path 9 "$USER_RELEASE_LOCK"
  "$FLOCK_BIN" -n 9 \
    || die "another staging, production, or Sonar-sensitive release action is active"

  assert_safe_lock_file "$ROOT_SONAR_LOCK" root:dominguez:660
  exec 8<>"$ROOT_SONAR_LOCK"
  assert_safe_lock_file "$ROOT_SONAR_LOCK" root:dominguez:660
  assert_lock_fd_matches_path 8 "$ROOT_SONAR_LOCK"
  "$FLOCK_BIN" -n 8 \
    || die "a Sonar backup, restore, or root maintenance action is active"
}

systemctl_value() {
  "$SYSTEMCTL_BIN" show --property="$2" --value "$1"
}

assert_detached_systemd_transaction() {
  local control_group unit active_state unit_type fragment_path
  local main_pid invocation_id
  [ "$MODE" = apply ] || return 0
  [[ "${INVOCATION_ID:-}" =~ ^[0-9a-f]{32}$ ]] \
    || die "apply must run inside a detached systemd retirement transaction"
  [[ "${SYSTEMD_EXEC_PID:-}" =~ ^[1-9][0-9]*$ ]] \
    && [ "$SYSTEMD_EXEC_PID" = "$$" ] \
    || die "systemd retirement transaction PID identity is invalid"
  [ -f "$SELF_CGROUP_FILE" ] && [ ! -L "$SELF_CGROUP_FILE" ] \
    || die "systemd retirement cgroup identity is unavailable"
  control_group=
  while IFS=: read -r hierarchy controllers candidate; do
    if [ "$hierarchy" = 0 ] && [ -z "$controllers" ]; then
      [ -z "$control_group" ] \
        || die "systemd retirement cgroup identity is ambiguous"
      control_group="$candidate"
    fi
  done <"$SELF_CGROUP_FILE"
  case "$control_group" in
    /system.slice/nexus-release-retirement-*.service) ;;
    *) die "apply is not running in the dedicated retirement service cgroup" ;;
  esac
  unit="${control_group##*/}"
  active_state="$(systemctl_value "$unit" ActiveState)"
  unit_type="$(systemctl_value "$unit" Type)"
  fragment_path="$(systemctl_value "$unit" FragmentPath)"
  main_pid="$(systemctl_value "$unit" MainPID)"
  invocation_id="$(systemctl_value "$unit" InvocationID)"
  [ "$(systemctl_value "$unit" LoadState)" = loaded ] \
    && { [ "$active_state" = active ] || [ "$active_state" = activating ]; } \
    && { [ "$unit_type" = simple ] || [ "$unit_type" = exec ] \
      || [ "$unit_type" = oneshot ]; } \
    && [ "$fragment_path" = "/run/systemd/transient/$unit" ] \
    && [ "$main_pid" = "$$" ] \
    && [ "$invocation_id" = "$INVOCATION_ID" ] \
    && [ "$(systemctl_value "$unit" ControlGroup)" = "$control_group" ] \
    || die "detached systemd retirement transaction identity is invalid"
}

path_exists() {
  [ -e "$1" ] || [ -L "$1" ]
}

assert_allowlisted_path() {
  local candidate="$1"
  local allowed
  for allowed in \
    "${LEGACY_DROP_INS[@]}" \
    "${LEGACY_DEPENDENCY_LINKS[@]}" \
    "${LEGACY_HELPERS[@]}" \
    "${LEGACY_STATE[@]}"; do
    [ "$candidate" != "$allowed" ] || return 0
  done
  for allowed in "${LEGACY_UNITS[@]}"; do
    [ "$candidate" != "/etc/systemd/system/$allowed" ] || return 0
  done
  die "refusing non-allowlisted removal path: $candidate"
}

remove_allowlisted_path() {
  local candidate="$1"
  assert_allowlisted_path "$candidate"
  if [ -L "$candidate" ] || [ -f "$candidate" ]; then
    rm -f -- "$candidate"
  elif [ -d "$candidate" ]; then
    rm -rf -- "$candidate"
  elif [ -e "$candidate" ]; then
    die "allowlisted path has an unsupported file type: $candidate"
  fi
}

read_getent_entry() {
  local database="$1"
  local key="$2"
  local status=0
  GETENT_RESULT=
  GETENT_FOUND=false
  GETENT_RESULT="$("$GETENT_BIN" "$database" "$key")" || status=$?
  case "$status" in
    0)
      [ -n "$GETENT_RESULT" ] \
        || die "empty identity lookup result for $database:$key"
      GETENT_FOUND=true
      ;;
    2)
      GETENT_RESULT=
      ;;
    *)
      die "identity lookup failed for $database:$key"
      ;;
  esac
}

assert_retired_kvm_owned_paths() {
  local allow_runtime_tree="${1:-false}"
  local scan_root inventory candidate
  inventory="$(mktemp)"
  chmod 0600 "$inventory"
  for scan_root in / /run; do
    if ! "$FIND_BIN" "$scan_root" -xdev \
        \( -uid "$RETIRED_KVM_UID" -o -gid "$RETIRED_KVM_GID" \) \
        -print0 >"$inventory"; then
      rm -f -- "$inventory"
      die "retired KVM ownership scan failed under $scan_root"
    fi
    while IFS= read -r -d '' candidate; do
      if [ "$allow_runtime_tree" = true ]; then
        case "$candidate" in
          "$RETIRED_KVM_RUNTIME_ROOT"|"$RETIRED_KVM_RUNTIME_ROOT"/*)
            continue
            ;;
        esac
      fi
      rm -f -- "$inventory"
      die "unexpected retired KVM uid/gid ownership remains: $candidate"
    done <"$inventory"
  done
  rm -f -- "$inventory"
}

assert_retired_kvm_identity_absent() {
  local database key
  for database in passwd group; do
    if [ "$database" = passwd ]; then
      for key in "$RETIRED_KVM_USER" "$RETIRED_KVM_UID"; do
        read_getent_entry "$database" "$key"
        [ "$GETENT_FOUND" = false ] \
          || die "retired KVM user identity still exists"
      done
    else
      for key in "$RETIRED_KVM_GROUP" "$RETIRED_KVM_GID"; do
        read_getent_entry "$database" "$key"
        [ "$GETENT_FOUND" = false ] \
          || die "retired KVM group identity still exists"
      done
    fi
  done
}

validate_retired_kvm_identity() {
  local passwd_entry passwd_by_uid group_entry group_by_gid
  local passwd_found group_found
  local kvm_group_entry kvm_name kvm_password kvm_gid kvm_members kvm_extra
  local member member_count=0 process_status=0
  local -a kvm_member_list=()
  RETIRED_KVM_IDENTITY_PRESENT=false
  RETIRED_KVM_ORPHAN_GROUP_PRESENT=false

  read_getent_entry passwd "$RETIRED_KVM_USER"
  passwd_entry="$GETENT_RESULT"
  passwd_found="$GETENT_FOUND"
  read_getent_entry group "$RETIRED_KVM_GROUP"
  group_entry="$GETENT_RESULT"
  group_found="$GETENT_FOUND"

  if [ "$passwd_found" = false ] && [ "$group_found" = false ]; then
    assert_retired_kvm_identity_absent
    assert_retired_kvm_owned_paths false
    return 0
  fi
  if [ "$passwd_found" = false ] && [ "$group_found" = true ]; then
    [ "$group_entry" = "$RETIRED_KVM_GROUP_ENTRY" ] \
      || die "orphaned retired KVM primary group differs from the audit"
    read_getent_entry passwd "$RETIRED_KVM_UID"
    [ "$GETENT_FOUND" = false ] \
      || die "retired KVM uid was reassigned after user removal"
    read_getent_entry group "$RETIRED_KVM_GID"
    [ "$GETENT_FOUND" = true ] && [ "$GETENT_RESULT" = "$group_entry" ] \
      || die "orphaned retired KVM gid does not resolve to the audited group"
    read_getent_entry group "$RETIRED_KVM_SUPPLEMENTARY_GROUP"
    kvm_group_entry="$GETENT_RESULT"
    [ "$GETENT_FOUND" = true ] \
      || die "audited KVM supplementary group is unavailable"
    IFS=: read -r kvm_name kvm_password kvm_gid kvm_members kvm_extra \
      <<<"$kvm_group_entry"
    [ "$kvm_name" = "$RETIRED_KVM_SUPPLEMENTARY_GROUP" ] \
      && [ "$kvm_gid" = "$RETIRED_KVM_SUPPLEMENTARY_GID" ] \
      && [ -z "$kvm_extra" ] \
      || die "KVM supplementary group identity differs from the audit"
    if [ -n "$kvm_members" ]; then
      IFS=, read -r -a kvm_member_list <<<"$kvm_members"
      for member in "${kvm_member_list[@]}"; do
        [ "$member" != "$RETIRED_KVM_USER" ] \
          || member_count=$((member_count + 1))
      done
    fi
    [ "$member_count" -eq 0 ] \
      || die "orphaned retired KVM supplementary membership remains"
    "$PGREP_BIN" -u "$RETIRED_KVM_UID" >/dev/null 2>&1 || process_status=$?
    [ "$process_status" -eq 1 ] \
      || die "retired KVM uid has an active process or process audit failed"
    assert_retired_kvm_owned_paths false
    RETIRED_KVM_ORPHAN_GROUP_PRESENT=true
    return 0
  fi
  [ "$passwd_found" = true ] && [ "$group_found" = true ] \
    || die "retired KVM user/group identity is incomplete"
  [ "$passwd_entry" = "$RETIRED_KVM_PASSWD_ENTRY" ] \
    && [ "$group_entry" = "$RETIRED_KVM_GROUP_ENTRY" ] \
    || die "retired KVM user/group identity differs from the audited account"

  read_getent_entry passwd "$RETIRED_KVM_UID"
  passwd_by_uid="$GETENT_RESULT"
  [ "$GETENT_FOUND" = true ] && [ "$passwd_by_uid" = "$passwd_entry" ] \
    || die "retired KVM uid does not resolve to the audited account"
  read_getent_entry group "$RETIRED_KVM_GID"
  group_by_gid="$GETENT_RESULT"
  [ "$GETENT_FOUND" = true ] && [ "$group_by_gid" = "$group_entry" ] \
    || die "retired KVM gid does not resolve to the audited group"

  [ "$("$ID_BIN" -u "$RETIRED_KVM_USER")" = "$RETIRED_KVM_UID" ] \
    && [ "$("$ID_BIN" -g "$RETIRED_KVM_USER")" = "$RETIRED_KVM_GID" ] \
    && [ "$("$ID_BIN" -G "$RETIRED_KVM_USER")" \
      = "$RETIRED_KVM_GID $RETIRED_KVM_SUPPLEMENTARY_GID" ] \
    && [ "$("$ID_BIN" -Gn "$RETIRED_KVM_USER")" \
      = "$RETIRED_KVM_GROUP $RETIRED_KVM_SUPPLEMENTARY_GROUP" ] \
    || die "retired KVM account membership differs from the audited identity"

  read_getent_entry group "$RETIRED_KVM_SUPPLEMENTARY_GROUP"
  kvm_group_entry="$GETENT_RESULT"
  [ "$GETENT_FOUND" = true ] \
    || die "audited KVM supplementary group is unavailable"
  IFS=: read -r kvm_name kvm_password kvm_gid kvm_members kvm_extra \
    <<<"$kvm_group_entry"
  [ "$kvm_name" = "$RETIRED_KVM_SUPPLEMENTARY_GROUP" ] \
    && [ "$kvm_gid" = "$RETIRED_KVM_SUPPLEMENTARY_GID" ] \
    && [ -z "$kvm_extra" ] \
    || die "KVM supplementary group identity differs from the audit"
  IFS=, read -r -a kvm_member_list <<<"$kvm_members"
  for member in "${kvm_member_list[@]}"; do
    [ "$member" != "$RETIRED_KVM_USER" ] || member_count=$((member_count + 1))
  done
  [ "$member_count" -eq 1 ] \
    || die "retired KVM account supplementary membership is not exact"

  "$PGREP_BIN" -u "$RETIRED_KVM_UID" >/dev/null 2>&1 || process_status=$?
  [ "$process_status" -eq 1 ] \
    || die "retired KVM account has an active process or process audit failed"
  assert_retired_kvm_owned_paths true
  RETIRED_KVM_IDENTITY_PRESENT=true
}

retire_kvm_identity() {
  validate_retired_kvm_identity
  if [ "$RETIRED_KVM_IDENTITY_PRESENT" = false ] \
      && [ "$RETIRED_KVM_ORPHAN_GROUP_PRESENT" = false ]; then
    assert_retired_kvm_identity_absent
    assert_retired_kvm_owned_paths false
    return 0
  fi
  if [ "$RETIRED_KVM_ORPHAN_GROUP_PRESENT" = true ]; then
    [ "$RETIRED_KVM_IDENTITY_PRESENT" = false ] \
      || die "retired KVM identity state is ambiguous before group retry"
    assert_retired_kvm_owned_paths false
    "$GROUPDEL_BIN" "$RETIRED_KVM_GROUP"
    RETIRED_KVM_ORPHAN_GROUP_PRESENT=false
    assert_retired_kvm_identity_absent
    assert_retired_kvm_owned_paths false
    return 0
  fi
  [ "$RETIRED_KVM_IDENTITY_PRESENT" = true ] \
    || die "retired KVM identity disappeared before account removal"
  assert_retired_kvm_owned_paths false
  "$USERDEL_BIN" "$RETIRED_KVM_USER"

  read_getent_entry passwd "$RETIRED_KVM_USER"
  [ "$GETENT_FOUND" = false ] \
    || die "retired KVM user name remains after userdel"
  read_getent_entry passwd "$RETIRED_KVM_UID"
  [ "$GETENT_FOUND" = false ] \
    || die "retired KVM uid remains after userdel"
  read_getent_entry group "$RETIRED_KVM_GROUP"
  if [ "$GETENT_FOUND" = true ]; then
    [ "$GETENT_RESULT" = "$RETIRED_KVM_GROUP_ENTRY" ] \
      || die "retired KVM primary group changed before groupdel"
    "$GROUPDEL_BIN" "$RETIRED_KVM_GROUP"
  else
    read_getent_entry group "$RETIRED_KVM_GID"
    [ "$GETENT_FOUND" = false ] \
      || die "retired KVM gid was reassigned during userdel"
  fi

  RETIRED_KVM_IDENTITY_PRESENT=false
  RETIRED_KVM_ORPHAN_GROUP_PRESENT=false
  assert_retired_kvm_identity_absent
  assert_retired_kvm_owned_paths false
}

prepare_pm2_blocker_backup() {
  local path retained_backup index=0
  if path_exists "$PM2_BLOCKER_BACKUP_ROOT"; then
    [ -d "$PM2_BLOCKER_BACKUP_ROOT" ] \
      && [ ! -L "$PM2_BLOCKER_BACKUP_ROOT" ] \
      && [ "$("$STAT_BIN" -c '%U:%G:%a' -- "$PM2_BLOCKER_BACKUP_ROOT")" \
        = root:root:700 ] \
      || die "persistent PM2 blocker backup root is unsafe"
  else
    install -o root -g root -m 0700 -d "$PM2_BLOCKER_BACKUP_ROOT"
  fi
  for retained_backup in "$PM2_BLOCKER_BACKUP_ROOT"/blockers.*; do
    path_exists "$retained_backup" \
      || continue
    die "a retained PM2 blocker backup requires manual recovery: $retained_backup"
  done
  PM2_BLOCKER_BACKUP="$(
    mktemp -d "$PM2_BLOCKER_BACKUP_ROOT/blockers.XXXXXX"
  )"
  chmod 0700 "$PM2_BLOCKER_BACKUP"
  mkdir -m 0700 "$PM2_BLOCKER_BACKUP/items"
  for path in "${LEGACY_DROP_INS[@]}" "${LEGACY_DEPENDENCY_LINKS[@]}"; do
    if path_exists "$path"; then
      cp -a -- "$path" "$PM2_BLOCKER_BACKUP/items/$index"
    fi
    index=$((index + 1))
  done
}

pm2_blocker_backup_path_is_valid() {
  case "$PM2_BLOCKER_BACKUP" in
    "$PM2_BLOCKER_BACKUP_ROOT"/blockers.*)
      [ -d "$PM2_BLOCKER_BACKUP" ] \
        && [ ! -L "$PM2_BLOCKER_BACKUP" ] \
        && [ -d "$PM2_BLOCKER_BACKUP/items" ] \
        && [ ! -L "$PM2_BLOCKER_BACKUP/items" ]
      ;;
    *) return 1 ;;
  esac
}

pm2_blocker_paths_are_equivalent() {
  local backup_path="$1"
  local live_path="$2"
  local backup_identity live_identity
  if [ -L "$backup_path" ] || [ -L "$live_path" ]; then
    [ -L "$backup_path" ] && [ -L "$live_path" ] \
      || return 1
    [ "$(readlink -- "$backup_path")" = "$(readlink -- "$live_path")" ] \
      || return 1
    return 0
  fi
  if [ -f "$backup_path" ] && [ -f "$live_path" ]; then
    backup_identity="$("$STAT_BIN" -Lc '%u:%g:%a:%F' -- "$backup_path")" \
      || return 1
    live_identity="$("$STAT_BIN" -Lc '%u:%g:%a:%F' -- "$live_path")" \
      || return 1
    [ "$backup_identity" = "$live_identity" ] \
      || return 1
    "$CMP_BIN" -s -- "$backup_path" "$live_path" \
      || return 1
    return 0
  fi
  if [ -d "$backup_path" ] && [ -d "$live_path" ]; then
    backup_identity="$("$STAT_BIN" -Lc '%u:%g:%a:%F' -- "$backup_path")" \
      || return 1
    live_identity="$("$STAT_BIN" -Lc '%u:%g:%a:%F' -- "$live_path")" \
      || return 1
    [ "$backup_identity" = "$live_identity" ] \
      || return 1
    "$DIFF_BIN" -qr -- "$backup_path" "$live_path" >/dev/null \
      || return 1
    return 0
  fi
  return 1
}

restore_pm2_blocker_backup() {
  local path backup_path parent index=0
  local restored=true
  pm2_blocker_backup_path_is_valid || {
    echo "retire legacy release machinery: PM2 blocker backup path is invalid" >&2
    return 1
  }
  for path in "${LEGACY_DROP_INS[@]}" "${LEGACY_DEPENDENCY_LINKS[@]}"; do
    backup_path="$PM2_BLOCKER_BACKUP/items/$index"
    if [ -e "$backup_path" ] || [ -L "$backup_path" ]; then
      if path_exists "$path"; then
        if ! pm2_blocker_paths_are_equivalent "$backup_path" "$path"; then
          echo "retire legacy release machinery: occupied PM2 blocker differs from backup: $path" >&2
          restored=false
        fi
      else
        parent="$(dirname -- "$path")"
        if [ ! -d "$parent" ] || [ -L "$parent" ] \
            || ! cp -a -- "$backup_path" "$path"; then
          echo "retire legacy release machinery: could not restore PM2 blocker: $path" >&2
          restored=false
        fi
      fi
    fi
    index=$((index + 1))
  done
  if ! "$SYSTEMCTL_BIN" daemon-reload; then
    echo "retire legacy release machinery: daemon-reload failed during PM2 blocker recovery" >&2
    restored=false
  fi
  [ "$restored" = true ]
}

discard_pm2_blocker_backup() {
  pm2_blocker_backup_path_is_valid \
    || die "PM2 blocker backup path is invalid"
  rm -rf -- "$PM2_BLOCKER_BACKUP" || return 1
  PM2_BLOCKER_BACKUP=
  rmdir -- "$PM2_BLOCKER_BACKUP_ROOT" 2>/dev/null || true
}

recover_pm2_blockers_on_exit() {
  local original_status="${1:-1}"
  trap - EXIT HUP INT TERM
  [ "$PM2_BLOCKER_GUARD_ARMED" = true ] || exit "$original_status"
  PM2_BLOCKER_GUARD_ARMED=false
  [ "$original_status" -ne 0 ] || original_status=1
  if restore_pm2_blocker_backup; then
    if discard_pm2_blocker_backup; then
      echo "retire legacy release machinery: guarded PM2 blockers restored" >&2
    else
      echo "retire legacy release machinery: restored PM2 blocker backup retained at $PM2_BLOCKER_BACKUP" >&2
    fi
  else
    echo "retire legacy release machinery: incomplete PM2 blocker recovery; persistent backup retained at $PM2_BLOCKER_BACKUP" >&2
  fi
  exit "$original_status"
}

arm_pm2_blocker_guard() {
  pm2_blocker_backup_path_is_valid \
    || die "cannot arm PM2 blocker recovery without a valid backup"
  PM2_BLOCKER_GUARD_ARMED=true
  trap 'recover_pm2_blockers_on_exit "$?"' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

disarm_pm2_blocker_guard() {
  [ "$PM2_BLOCKER_GUARD_ARMED" = true ] \
    || die "PM2 blocker recovery guard is not armed"
  PM2_BLOCKER_GUARD_ARMED=false
  trap - EXIT HUP INT TERM
  discard_pm2_blocker_backup
}

validate_production_gate() {
  local current_target identity
  [ -f "$STATE_FILE" ] && [ ! -L "$STATE_FILE" ] || die "lean production transaction state is unavailable"
  [ -L "$CURRENT_LINK" ] || die "production current selector is not a symlink"
  current_target="$(realpath -e -- "$CURRENT_LINK")"
  case "$current_target" in
    "$PRODUCTION_BASE"/releases/*) ;;
    *) die "production current selector escapes the lean release set" ;;
  esac
  [ -f "$current_target/.complete.json" ] && [ ! -L "$current_target/.complete.json" ] \
    || die "current completion marker is unavailable"

  identity="$(
    "$NODE_BIN" - "$STATE_FILE" "$current_target/.complete.json" \
      "$current_target" "$CONFIRMATION" "$PRODUCTION_BASE" <<'NODE'
const fs=require('node:fs');
const [statePath,markerPath,currentTarget,confirmation,productionBase]=process.argv.slice(2);
const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
const marker=JSON.parse(fs.readFileSync(markerPath,'utf8'));
const checks={
  artifactParity:'passed',
  migrationStartup:'passed',
  authenticatedSmoke:'passed',
  databaseIntegrity:'passed',
  prePromotionBackup:'passed',
  rollbackReadiness:'passed',
};
const exactChecks=state?.checks
  && JSON.stringify(Object.keys(state.checks).sort())
    ===JSON.stringify(Object.keys(checks).sort())
  && Object.entries(checks).every(([name,status])=>state.checks[name]===status);
const transactionStarted=Date.parse(state?.startedAt??'');
const soakStarted=Date.parse(state?.soakStartedAt??'');
const soakCompleted=Date.parse(state?.soakCompletedAt??'');
const transactionCompleted=Date.parse(state?.completedAt??'');
const updated=Date.parse(state?.updatedAt??'');
if(state?.schema!=='nexus.lean-release-transaction.v1'
  ||state.role!=='production'
  ||state.phase!=='completed'
  ||state.status!=='passed'
  ||state.healthResult!=='passed'
  ||state.rollbackResult!=='not_required'
  ||state.rollbackDurationMs!==null
  ||state.faultInjection!==null
  ||state.candidateRemoved!==false
  ||state.releaseDir!==currentTarget
  ||typeof state.predecessor!=='string'
  ||!state.predecessor.startsWith(`${productionBase}/releases/`)
  ||state.predecessor===currentTarget
  ||!/^[0-9a-f]{40}$/.test(state.runtimeSha??'')
  ||!/^[0-9a-f]{64}$/.test(state.artifactDigest??'')
  ||!Number.isSafeInteger(state.stabilitySeconds)
  ||state.stabilitySeconds<60
  ||state.candidateHealthBudgetSeconds!==45
  ||state.rollbackHealthBudgetSeconds!==45
  ||state.rollbackObjectiveSeconds!==120
  ||![transactionStarted,soakStarted,soakCompleted,transactionCompleted,updated]
    .every(Number.isFinite)
  ||transactionStarted>soakStarted
  ||soakCompleted>transactionCompleted
  ||transactionCompleted>updated
  ||soakCompleted-soakStarted<state.stabilitySeconds*1000
  ||!exactChecks
  ||marker?.schema!=='nexus.release-bundle.v1'
  ||marker.runtimeSha!==state.runtimeSha
  ||marker.artifactDigest!==state.artifactDigest
  ||typeof marker.packageVersion!=='string'
  ||marker.packageVersion.length===0
  ||currentTarget
    !==`${productionBase}/releases/${state.runtimeSha}-${state.artifactDigest.slice(0,12)}`
  ||(confirmation&&confirmation!==`${state.runtimeSha}:${state.artifactDigest}`)){
  process.exit(1);
}
process.stdout.write(`${state.runtimeSha}\t${state.artifactDigest}\t${currentTarget}`);
NODE
  )" || die "production transaction/current/completion-marker proof is invalid"
  IFS=$'\t' read -r PRODUCTION_SHA PRODUCTION_DIGEST PRODUCTION_RELEASE <<<"$identity"
}

read_role_identity() {
  local base="$1"
  local current_link="$2"
  local current_target
  [ -L "$current_link" ] || return 1
  current_target="$(realpath -e -- "$current_link")" || return 1
  case "$current_target" in
    "$base"/releases/*) ;;
    *) return 1 ;;
  esac
  [ -f "$current_target/.complete.json" ] \
    && [ ! -L "$current_target/.complete.json" ] || return 1
  "$NODE_BIN" - "$current_target/.complete.json" "$current_target" <<'NODE'
const fs=require('node:fs');
const [markerPath,currentTarget]=process.argv.slice(2);
const marker=JSON.parse(fs.readFileSync(markerPath,'utf8'));
if(marker?.schema!=='nexus.release-bundle.v1'
  ||!/^[0-9a-f]{40}$/.test(marker.runtimeSha??'')
  ||!/^[0-9a-f]{64}$/.test(marker.artifactDigest??''))process.exit(1);
process.stdout.write(`${currentTarget}\t${marker.runtimeSha}\t${marker.artifactDigest}`);
NODE
}

detect_pm2_authority() {
  local canonical_active=false temporary_active=false unit main_pid control_group
  "$SYSTEMCTL_BIN" is-active --quiet "$CANONICAL_PM2_UNIT" \
    && canonical_active=true || true
  "$SYSTEMCTL_BIN" is-active --quiet "$TEMPORARY_PM2_UNIT" \
    && temporary_active=true || true
  if [ "$canonical_active" = "$temporary_active" ]; then
    echo "retire legacy release machinery: exactly one governed PM2 authority must be active" >&2
    return 1
  fi
  if [ "$canonical_active" = true ]; then
    unit="$CANONICAL_PM2_UNIT"
    expected_control_group="/system.slice/$CANONICAL_PM2_UNIT"
  else
    unit="$TEMPORARY_PM2_UNIT"
    expected_control_group="/system.slice/$TEMPORARY_PM2_UNIT"
  fi
  main_pid="$("$SYSTEMCTL_BIN" show --property=MainPID --value "$unit")"
  control_group="$("$SYSTEMCTL_BIN" show --property=ControlGroup --value "$unit")"
  [[ "$main_pid" =~ ^[1-9][0-9]*$ ]] \
    && [ "$control_group" = "$expected_control_group" ] \
    && [ -f "$PM2_HOME/pm2.pid" ] \
    && [ "$(tr -d '[:space:]' <"$PM2_HOME/pm2.pid")" = "$main_pid" ] || {
    echo "retire legacy release machinery: governed PM2 authority identity is invalid" >&2
    return 1
  }
  printf '%s\t%s\t%s\n' "$unit" "$main_pid" "$control_group"
}

refresh_pm2_authority() {
  local authority
  authority="$(detect_pm2_authority)" || return 1
  IFS=$'\t' read -r PM2_AUTHORITY_UNIT PM2_AUTHORITY_PID \
    PM2_AUTHORITY_CGROUP <<<"$authority"
}

validate_pm2_inventory() {
  local inventory="$1"
  local kind="$2"
  local production_release="$3"
  local production_sha="$4"
  local production_digest="$5"
  local staging_release="$6"
  local staging_sha="$7"
  local staging_digest="$8"
  "$NODE_BIN" - "$inventory" "$kind" \
    "$production_release" "$production_sha" "$production_digest" \
    "$staging_release" "$staging_sha" "$staging_digest" <<'NODE'
const fs=require('node:fs');
const [inventoryPath,kind,productionRelease,productionSha,productionDigest,
  stagingRelease,stagingSha,stagingDigest]=process.argv.slice(2);
const rows=JSON.parse(fs.readFileSync(inventoryPath,'utf8'));
if(!Array.isArray(rows)||!new Set(['live','dump']).has(kind))process.exit(1);
const expected=new Map([
 ['nexus-hub',{cwd:productionRelease,sha:productionSha,digest:productionDigest}],
 ['content-engine',{cwd:`${productionRelease}/content-engine`,
   sha:productionSha,digest:productionDigest}],
 ['nexus-hub-staging',{cwd:stagingRelease,sha:stagingSha,digest:stagingDigest}],
 ['content-engine-staging',{cwd:`${stagingRelease}/content-engine`,
   sha:stagingSha,digest:stagingDigest}],
]);
if(rows.length!==expected.size
  ||new Set(rows.map((row)=>row?.name)).size!==expected.size)process.exit(1);
for(const row of rows){
  const wanted=expected.get(row?.name);
  const environment=kind==='live'?row?.pm2_env:row;
  if(!wanted||!environment
    ||(kind==='live'&&environment.status!=='online')
    ||environment.pm_cwd!==wanted.cwd
    ||(environment.NEXUS_RELEASE_SHA??environment.GIT_COMMIT)!==wanted.sha
    ||environment.NEXUS_RELEASE_ARTIFACT_SHA256!==wanted.digest)process.exit(1);
}
NODE
}

capture_and_validate_live_pm2() {
  local production_release="$1"
  local production_sha="$2"
  local production_digest="$3"
  local staging_release="$4"
  local staging_sha="$5"
  local staging_digest="$6"
  local snapshot_timeout_seconds="${7:-$PM2_SNAPSHOT_TIMEOUT_SECONDS}"
  local snapshot
  snapshot="$(mktemp)"
  chmod 0600 "$snapshot"
  if ! "$TIMEOUT_BIN" --foreground "${snapshot_timeout_seconds}s" \
      "$RUNUSER_BIN" -u dominguez -- env \
      HOME="$DEPLOY_HOME" \
      USER=dominguez \
      LOGNAME=dominguez \
      PATH=/usr/local/bin:/usr/bin:/bin \
      PM2_HOME="$PM2_HOME" \
      "$PM2_BIN" jlist >"$snapshot"; then
    rm -f -- "$snapshot"
    return 1
  fi
  if ! validate_pm2_inventory "$snapshot" live \
      "$production_release" "$production_sha" "$production_digest" \
      "$staging_release" "$staging_sha" "$staging_digest"; then
    rm -f -- "$snapshot"
    return 1
  fi
  rm -f -- "$snapshot"
}

assert_resurrection_dump() {
  local production_release="$1"
  local production_sha="$2"
  local production_digest="$3"
  local staging_release="$4"
  local staging_sha="$5"
  local staging_digest="$6"
  [ -f "$PM2_DUMP" ] && [ ! -L "$PM2_DUMP" ] \
    && [ "$(stat -c '%U:%G:%a' "$PM2_DUMP")" = dominguez:dominguez:600 ] \
    || die "PM2 resurrection dump is missing or unsafe"
  validate_pm2_inventory "$PM2_DUMP" dump \
    "$production_release" "$production_sha" "$production_digest" \
    "$staging_release" "$staging_sha" "$staging_digest" \
    || die "PM2 resurrection dump does not match the exact live releases"
}

assert_runtime_health() {
  local expected_authority="${1:-}"
  local deadline="${2:-0}"
  local current_target staging_identity
  local staging_release staging_sha staging_digest
  local health_check health_name health_url request_timeout snapshot_timeout
  refresh_pm2_authority || die "governed PM2 authority is unavailable"
  [ -z "$expected_authority" ] || [ "$PM2_AUTHORITY_UNIT" = "$expected_authority" ] \
    || die "PM2 authority differs from the expected supervisor"
  current_target="$(realpath -e -- "$CURRENT_LINK")"
  [ "$current_target" = "$PRODUCTION_RELEASE" ] \
    || die "production current selector changed during retirement"
  staging_identity="$(read_role_identity "$STAGING_BASE" "$STAGING_CURRENT_LINK")" \
    || die "staging current identity is unavailable"
  IFS=$'\t' read -r staging_release staging_sha staging_digest <<<"$staging_identity"
  for health_check in \
    'production backend:http://127.0.0.1:8200/health' \
    'production content-engine:http://127.0.0.1:8100/health' \
    'staging backend:http://127.0.0.1:8201/health' \
    'staging content-engine:http://127.0.0.1:8101/health'; do
    IFS=: read -r health_name health_url <<<"$health_check"
    request_timeout="$HEALTH_HTTP_TIMEOUT_SECONDS"
    if [ "$deadline" -gt 0 ]; then
      request_timeout=$((deadline - SECONDS))
      [ "$request_timeout" -gt 0 ] \
        || die "runtime health budget expired before $health_name"
      [ "$request_timeout" -le "$HEALTH_HTTP_TIMEOUT_SECONDS" ] \
        || request_timeout="$HEALTH_HTTP_TIMEOUT_SECONDS"
    fi
    "$CURL_BIN" --fail --silent --show-error \
      --max-time "$request_timeout" "$health_url" >/dev/null \
      || die "$health_name health failed"
  done
  snapshot_timeout="$PM2_SNAPSHOT_TIMEOUT_SECONDS"
  if [ "$deadline" -gt 0 ]; then
    snapshot_timeout=$((deadline - SECONDS))
    [ "$snapshot_timeout" -gt 0 ] \
      || die "runtime health budget expired before PM2 inventory verification"
    [ "$snapshot_timeout" -le "$PM2_SNAPSHOT_TIMEOUT_SECONDS" ] \
      || snapshot_timeout="$PM2_SNAPSHOT_TIMEOUT_SECONDS"
  fi
  capture_and_validate_live_pm2 \
    "$PRODUCTION_RELEASE" "$PRODUCTION_SHA" "$PRODUCTION_DIGEST" \
    "$staging_release" "$staging_sha" "$staging_digest" "$snapshot_timeout" \
    || die "PM2 does not bind all four processes to the exact lean releases"
  assert_resurrection_dump \
    "$PRODUCTION_RELEASE" "$PRODUCTION_SHA" "$PRODUCTION_DIGEST" \
    "$staging_release" "$staging_sha" "$staging_digest"
  [ "$(realpath -e -- "$CURRENT_LINK")" = "$PRODUCTION_RELEASE" ] \
    || die "production current selector changed during health verification"
  [ "$(realpath -e -- "$STAGING_CURRENT_LINK")" = "$staging_release" ] \
    || die "staging current selector changed during health verification"
}

wait_runtime_health() {
  local expected_authority="$1"
  local budget_seconds="${2:-$PM2_HANDOFF_HEALTH_BUDGET_SECONDS}"
  local deadline=$((SECONDS + budget_seconds))
  local remaining sleep_seconds
  [ "$budget_seconds" -gt 0 ] || return 1
  while [ "$SECONDS" -lt "$deadline" ]; do
    if ( assert_runtime_health "$expected_authority" "$deadline" ) \
        >/dev/null 2>&1; then
      return 0
    fi
    remaining=$((deadline - SECONDS))
    [ "$remaining" -gt 0 ] || return 1
    sleep_seconds=2
    [ "$sleep_seconds" -le "$remaining" ] || sleep_seconds="$remaining"
    sleep "$sleep_seconds"
  done
  return 1
}

assert_no_active_legacy_transaction() {
  local inventory unit _load _active _sub _description
  inventory="$(
    "$SYSTEMCTL_BIN" list-units --type=service \
      --state=activating,active,reloading,deactivating \
      --no-legend --no-pager
  )" || die "cannot inventory active systemd services"
  while read -r unit _load _active _sub _description; do
    case "$unit" in
      nexus-release-layout-activation@*.service|\
      nexus-release-layout-fault-drill@*.service|\
      nexus-release-promotion@*.service|\
      nexus-rollback-drill-v4-prelayout-staging@*.service|\
      nexus-rollback-drill-vm@*.service)
        die "legacy transaction is still active: $unit"
        ;;
    esac
  done <<<"$inventory"
}

read_unit_load_state() {
  local unit="$1"
  local load_state
  load_state="$(
    "$SYSTEMCTL_BIN" show --property=LoadState --value "$unit" 2>/dev/null
  )" || return 1
  [ -n "$load_state" ] && [[ "$load_state" != *$'\n'* ]] || return 1
  printf '%s\n' "$load_state"
}

disable_legacy_unit() {
  local unit="$1"
  local load_state
  load_state="$(read_unit_load_state "$unit")" \
    || die "cannot determine legacy unit load state: $unit"
  if [ "$load_state" != not-found ]; then
    case "$unit" in
      *@.service)
        # Active instances were rejected above. Never pass a template to
        # `disable --now`, whose instance semantics vary by systemd version.
        "$SYSTEMCTL_BIN" disable "$unit" >/dev/null
        ;;
      *)
        "$SYSTEMCTL_BIN" disable --now "$unit" >/dev/null
        ;;
    esac
  fi
  if [ "$unit" = nexus-rollback-drill-v4-prelayout-staging-recovery.service ]; then
    # A removed unit can retain a not-found/failed cache entry. Clear only the
    # audited stale recovery unit; absence is already the desired state.
    "$SYSTEMCTL_BIN" reset-failed "$unit" >/dev/null 2>&1 || true
  fi
}

assert_effective_pm2_command() {
  local property="$1"
  local operation="$2"
  local value expected_prefix
  value="$(systemctl_value "$CANONICAL_PM2_UNIT" "$property")"
  expected_prefix="{ path=$CANONICAL_PM2_EXEC ; argv[]=$CANONICAL_PM2_EXEC $operation ; ignore_errors=no ; "
  [[ "$value" = "$expected_prefix"* ]] \
    || die "canonical PM2 $property is not the audited $operation command"
}

assert_canonical_pm2_unit_ready() {
  local enabled group environment relationships property
  enabled="$("$SYSTEMCTL_BIN" is-enabled "$CANONICAL_PM2_UNIT" 2>/dev/null)" \
    || die "canonical PM2 service is not enabled"
  [ "$enabled" = enabled ] \
    && [ "$(systemctl_value "$CANONICAL_PM2_UNIT" LoadState)" = loaded ] \
    && [ "$(systemctl_value "$CANONICAL_PM2_UNIT" UnitFileState)" = enabled ] \
    && [ "$(systemctl_value "$CANONICAL_PM2_UNIT" FragmentPath)" \
      = "$CANONICAL_PM2_UNIT_FILE" ] \
    && [ "$(systemctl_value "$CANONICAL_PM2_UNIT" Type)" = forking ] \
    && [ "$(systemctl_value "$CANONICAL_PM2_UNIT" User)" = dominguez ] \
    && [ "$(systemctl_value "$CANONICAL_PM2_UNIT" PIDFile)" = "$PM2_HOME/pm2.pid" ] \
    && [ "$(systemctl_value "$CANONICAL_PM2_UNIT" RemainAfterExit)" = no ] \
    && [ "$(systemctl_value "$CANONICAL_PM2_UNIT" Restart)" = on-failure ] \
    && [ "$(systemctl_value "$CANONICAL_PM2_UNIT" WantedBy)" = multi-user.target ] \
    && [ -f "$CANONICAL_PM2_UNIT_FILE" ] \
    && [ ! -L "$CANONICAL_PM2_UNIT_FILE" ] \
    && [ "$("$STAT_BIN" -c '%U:%G:%a' -- "$CANONICAL_PM2_UNIT_FILE")" \
      = root:root:644 ] \
    || die "canonical PM2 service is not reboot-safe after blocker removal"
  group="$(systemctl_value "$CANONICAL_PM2_UNIT" Group)"
  { [ -z "$group" ] || [ "$group" = dominguez ]; } \
    || die "canonical PM2 service group is unsafe"
  [ -z "$(systemctl_value "$CANONICAL_PM2_UNIT" DropInPaths)" ] \
    && [ -z "$(systemctl_value "$CANONICAL_PM2_UNIT" ExecCondition)" ] \
    && [ -z "$(systemctl_value "$CANONICAL_PM2_UNIT" ExecStartPre)" ] \
    || die "canonical PM2 service still has unaudited effective overrides"
  environment="$(systemctl_value "$CANONICAL_PM2_UNIT" Environment)"
  [[ " $environment " = *" PM2_HOME=$PM2_HOME "* ]] \
    || die "canonical PM2 service does not use the governed PM2 home"
  for property in Requires Wants Requisite BindsTo PartOf; do
    relationships="$(systemctl_value "$CANONICAL_PM2_UNIT" "$property")"
    [[ "$relationships" != *nexus-release-* ]] \
      && [[ "$relationships" != *nexus-rollback-drill-* ]] \
      || die "canonical PM2 service still depends on legacy release machinery"
  done
  assert_effective_pm2_command ExecStart resurrect
  assert_effective_pm2_command ExecReload 'reload all'
  assert_effective_pm2_command ExecStop kill
}

assert_no_legacy_pm2_ordering() {
  local relationships property
  for property in After Before; do
    relationships="$(systemctl_value "$CANONICAL_PM2_UNIT" "$property")"
    [[ "$relationships" != *nexus-release-* ]] \
      && [[ "$relationships" != *nexus-rollback-drill-* ]] \
      || die "canonical PM2 service still has legacy ordering references"
  done
}

resurrect_temporary_pm2() {
  "$SYSTEMCTL_BIN" reset-failed "$TEMPORARY_PM2_UNIT" >/dev/null 2>&1 || true
  "$TIMEOUT_BIN" --foreground "${SERVICE_CONTROL_TIMEOUT_SECONDS}s" \
    "$SYSTEMCTL_BIN" start "$TEMPORARY_PM2_UNIT" \
    || return 1
  "$TIMEOUT_BIN" --foreground "${PM2_RESURRECT_TIMEOUT_SECONDS}s" \
    "$RUNUSER_BIN" -u dominguez -- env \
    HOME="$DEPLOY_HOME" \
    USER=dominguez \
    LOGNAME=dominguez \
    PATH=/usr/local/bin:/usr/bin:/bin \
    PM2_HOME="$PM2_HOME" \
    "$PM2_BIN" resurrect >/dev/null
}

recover_temporary_pm2_authority() {
  local active_state main_pid settle_deadline remaining sleep_seconds
  "$TIMEOUT_BIN" --foreground "${SERVICE_CONTROL_TIMEOUT_SECONDS}s" \
    "$SYSTEMCTL_BIN" stop "$CANONICAL_PM2_UNIT" >/dev/null 2>&1 || true
  settle_deadline=$((SECONDS + SERVICE_CONTROL_TIMEOUT_SECONDS))
  while :; do
    active_state="$(systemctl_value "$CANONICAL_PM2_UNIT" ActiveState)" \
      || return 1
    main_pid="$(systemctl_value "$CANONICAL_PM2_UNIT" MainPID)" \
      || return 1
    if { [ "$active_state" = inactive ] || [ "$active_state" = failed ]; } \
        && [ "$main_pid" = 0 ]; then
      break
    fi
    if [ "$active_state" = active ] \
        && [[ "$main_pid" =~ ^[1-9][0-9]*$ ]]; then
      if wait_runtime_health "$CANONICAL_PM2_UNIT" \
          "$PM2_HANDOFF_HEALTH_BUDGET_SECONDS" \
          && refresh_pm2_authority \
          && [ "$PM2_AUTHORITY_UNIT" = "$CANONICAL_PM2_UNIT" ]; then
        return 0
      fi
      echo "retire legacy release machinery: canonical PM2 remained active but was not healthy; temporary supervisor was not started" >&2
      return 1
    fi
    remaining=$((settle_deadline - SECONDS))
    if [ "$remaining" -le 0 ]; then
      echo "retire legacy release machinery: canonical PM2 state remained ambiguous; temporary supervisor was not started" >&2
      return 1
    fi
    sleep_seconds=1
    [ "$sleep_seconds" -le "$remaining" ] || sleep_seconds="$remaining"
    sleep "$sleep_seconds"
  done
  if resurrect_temporary_pm2 \
      && wait_runtime_health "$TEMPORARY_PM2_UNIT" \
        "$PM2_HANDOFF_HEALTH_BUDGET_SECONDS"; then
    refresh_pm2_authority || return 1
    [ "$PM2_AUTHORITY_UNIT" = "$TEMPORARY_PM2_UNIT" ]
    return
  fi
  return 1
}

handoff_pm2_authority() {
  [ "$PM2_AUTHORITY_UNIT" = "$TEMPORARY_PM2_UNIT" ] || {
    [ "$PM2_AUTHORITY_UNIT" = "$CANONICAL_PM2_UNIT" ] \
      || die "unexpected PM2 authority before handoff"
    if refresh_pm2_authority \
        && [ "$PM2_AUTHORITY_UNIT" = "$CANONICAL_PM2_UNIT" ]; then
      return 0
    fi
    return 1
  }

  if ! "$TIMEOUT_BIN" --foreground "${SERVICE_CONTROL_TIMEOUT_SECONDS}s" \
      "$SYSTEMCTL_BIN" stop "$TEMPORARY_PM2_UNIT"; then
    if recover_temporary_pm2_authority; then
      if [ "$PM2_AUTHORITY_UNIT" = "$CANONICAL_PM2_UNIT" ]; then
        echo "retire legacy release machinery: temporary PM2 stop timed out; canonical authority is healthy" >&2
        return 0
      fi
      echo "retire legacy release machinery: temporary PM2 stop failed; temporary authority recovered" >&2
    else
      echo "retire legacy release machinery: temporary PM2 stop failed and bounded recovery failed" >&2
    fi
    return 1
  fi
  "$SYSTEMCTL_BIN" reset-failed "$CANONICAL_PM2_UNIT" >/dev/null 2>&1 || true
  if "$TIMEOUT_BIN" --foreground "${SERVICE_CONTROL_TIMEOUT_SECONDS}s" \
      "$SYSTEMCTL_BIN" start "$CANONICAL_PM2_UNIT" \
      && wait_runtime_health "$CANONICAL_PM2_UNIT" \
        "$PM2_HANDOFF_HEALTH_BUDGET_SECONDS" \
      && refresh_pm2_authority \
      && [ "$PM2_AUTHORITY_UNIT" = "$CANONICAL_PM2_UNIT" ]; then
    return 0
  fi

  if recover_temporary_pm2_authority; then
    if [ "$PM2_AUTHORITY_UNIT" = "$CANONICAL_PM2_UNIT" ]; then
      echo "retire legacy release machinery: canonical PM2 authority recovered after the handoff check" >&2
      return 0
    fi
    echo "retire legacy release machinery: canonical PM2 handoff failed; temporary authority restored" >&2
    return 1
  fi
  echo "retire legacy release machinery: canonical PM2 handoff failed and bounded temporary recovery failed" >&2
  return 1
}

run_retirement() {
  local planned=0
  local path unit load_state handoff_required
  assert_detached_systemd_transaction
  acquire_retirement_locks
  validate_production_gate
  assert_runtime_health
  assert_no_active_legacy_transaction
  validate_retired_kvm_identity

  for path in \
    "${LEGACY_DROP_INS[@]}" \
    "${LEGACY_DEPENDENCY_LINKS[@]}" \
    "${LEGACY_HELPERS[@]}" \
    "${LEGACY_STATE[@]}"; do
    if path_exists "$path"; then
      planned=$((planned + 1))
      [ "$MODE" != dry-run ] || printf 'would remove %s\n' "$path"
    fi
  done
  for unit in "${LEGACY_UNITS[@]}"; do
    load_state="$(read_unit_load_state "$unit")" \
      || die "cannot determine legacy unit load state while planning: $unit"
    if [ "$load_state" != not-found ]; then
      planned=$((planned + 1))
      [ "$MODE" != dry-run ] || printf 'would disable and remove %s\n' "$unit"
    fi
  done
  if [ "$RETIRED_KVM_IDENTITY_PRESENT" = true ]; then
    planned=$((planned + 2))
    if [ "$MODE" = dry-run ]; then
      printf 'would remove system user %s\n' "$RETIRED_KVM_USER"
      printf 'would remove system group %s\n' "$RETIRED_KVM_GROUP"
    fi
  elif [ "$RETIRED_KVM_ORPHAN_GROUP_PRESENT" = true ]; then
    planned=$((planned + 1))
    [ "$MODE" != dry-run ] \
      || printf 'would remove orphaned system group %s\n' "$RETIRED_KVM_GROUP"
  fi

  if [ "$MODE" = dry-run ]; then
    handoff_required=false
    [ "$PM2_AUTHORITY_UNIT" != "$TEMPORARY_PM2_UNIT" ] || handoff_required=true
    printf '{"ok":true,"mode":"dry-run","runtimeSha":"%s","artifactDigest":"%s","planned":%d,"pm2Authority":"%s","handoffRequired":%s}\n' \
      "$PRODUCTION_SHA" "$PRODUCTION_DIGEST" "$planned" \
      "$PM2_AUTHORITY_UNIT" "$handoff_required"
    return 0
  fi

  # Remove PM2/ingress dependency declarations before stopping their providers.
  prepare_pm2_blocker_backup
  arm_pm2_blocker_guard
  for path in "${LEGACY_DROP_INS[@]}" "${LEGACY_DEPENDENCY_LINKS[@]}"; do
    remove_allowlisted_path "$path"
  done
  "$SYSTEMCTL_BIN" daemon-reload
  assert_canonical_pm2_unit_ready
  assert_runtime_health "$PM2_AUTHORITY_UNIT"
  if ! handoff_pm2_authority; then
    die "legacy retirement stopped after the bounded PM2 recovery path"
  fi
  disarm_pm2_blocker_guard

  for unit in "${LEGACY_UNITS[@]}"; do
    disable_legacy_unit "$unit"
  done
  assert_runtime_health "$CANONICAL_PM2_UNIT"

  for unit in "${LEGACY_UNITS[@]}"; do
    remove_allowlisted_path "/etc/systemd/system/$unit"
  done
  for path in "${LEGACY_HELPERS[@]}" "${LEGACY_STATE[@]}"; do
    remove_allowlisted_path "$path"
  done

  rmdir --ignore-fail-on-non-empty \
    /etc/systemd/system/pm2-dominguez.service.d \
    /etc/systemd/system/pm2-dominguez.service.requires \
    /etc/systemd/system/pm2-root.service.d \
    /etc/systemd/system/pm2-root.service.requires \
    /etc/systemd/system/nexus-release-promotion-recovery.service.d \
    /etc/systemd/system/nexus-cloudflared.service.d 2>/dev/null || true
  "$SYSTEMCTL_BIN" daemon-reload
  assert_canonical_pm2_unit_ready
  assert_no_legacy_pm2_ordering
  assert_runtime_health "$CANONICAL_PM2_UNIT"
  retire_kvm_identity
  assert_runtime_health "$CANONICAL_PM2_UNIT"

  printf '{"ok":true,"mode":"apply","runtimeSha":"%s","artifactDigest":"%s","retired":%d}\n' \
    "$PRODUCTION_SHA" "$PRODUCTION_DIGEST" "$planned"
}

if [ "$SCRIPT_SOURCED" = true ]; then
  return 0 2>/dev/null || exit 0
fi
run_retirement
