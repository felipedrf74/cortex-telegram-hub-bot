#!/usr/bin/env bash
# Serialized entry point for the unattended release poller.
#
# This wrapper is the ONLY sanctioned way to start a deployment. Kernel
# flock(2) provides the mutual exclusion, and because the lock is held on a file
# descriptor the kernel releases it when the process dies — so an interrupted
# release never leaves a lock behind for the next run to detect, age out, or get
# wedged on.
#
# --nonblock is deliberate. If another release is running, the correct behaviour
# is to exit quietly and let the 30-second timer try again, not to queue pollers
# behind each other.
#
# NEXUS_RELEASE_LOCK_HELD is what the deployment code checks: running
# scripts/release-deploy.mjs directly is refused, so a hand-run deploy cannot
# race the systemd poller.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
NODE_BIN="${NEXUS_RELEASE_NODE_BIN:-/usr/bin/node}"
FLOCK_BIN="${NEXUS_RELEASE_FLOCK_BIN:-/usr/bin/flock}"
SYSTEMCTL_BIN="${NEXUS_RELEASE_SYSTEMCTL_BIN:-/usr/bin/systemctl}"

die() {
  echo "release poll refused: $*" >&2
  exit 1
}

PM2_RETIREMENT_JOURNAL=/var/lib/nexus-release/state/pm2-fallback-retirement.json
PM2_RETIRED_TOMBSTONE=/var/lib/nexus-release/state/pm2-fallback-retired.json
if [ -e "$PM2_RETIREMENT_JOURNAL" ] || [ -L "$PM2_RETIREMENT_JOURNAL" ]; then
  die "PM2 fallback retirement is in progress"
fi
if [ "${1:-}" = --allow-first-container-bootstrap ] \
    && { [ -e "$PM2_RETIRED_TOMBSTONE" ] || [ -L "$PM2_RETIRED_TOMBSTONE" ]; }; then
  die "first-container bootstrap is permanently barred after PM2 fallback retirement"
fi

assert_lock_fd_matches_path() {
  local descriptor="$1"
  local lock_path="$2"
  [ "$(stat -Lc '%d:%i' -- "/proc/$$/fd/$descriptor")" \
      = "$(stat -Lc '%d:%i' -- "$lock_path")" ] \
    || die "release mutex changed identity while it was acquired"
}

assert_pm2_guard() {
  local active_state can_start fragment guard load_state unit
  local guard_root=/etc/systemd/system.control
  [ -x "$SYSTEMCTL_BIN" ] || die "systemctl is required for PM2 guard proof"
  [ -d "$guard_root" ] && [ ! -L "$guard_root" ] \
    && [ "$(stat -Lc '%U:%G:%a' -- "$guard_root")" = root:root:755 ] \
    || die "PM2 high-priority persistent guard root is unsafe"
  for unit in pm2-dominguez.service nexus-release-pm2-recovery-daemon.service; do
    guard="$guard_root/$unit"
    [ -L "$guard" ] && [ "$(readlink -- "$guard")" = /dev/null ] \
      && [ "$(stat -c '%U:%G:%F' -- "$guard")" = \
        'root:root:symbolic link' ] \
      || die "$unit high-priority persistent guard is not exact"
    load_state="$($SYSTEMCTL_BIN show "$unit" --property=LoadState --value)"
    fragment="$($SYSTEMCTL_BIN show "$unit" --property=FragmentPath --value)"
    can_start="$($SYSTEMCTL_BIN show "$unit" --property=CanStart --value)"
    active_state="$($SYSTEMCTL_BIN show "$unit" --property=ActiveState --value)"
    [ "$load_state" = masked ] && [ "$fragment" = "$guard" ] \
      && [ "$can_start" = no ] && [ "$active_state" = inactive ] \
      || die "$unit is not effectively blocked by its high-priority persistent guard"
  done
}

# Both lock paths come only from the governed deployment policy. In particular,
# poller.env and a hand-run wrapper cannot redirect either mutex and silently
# split serialization between two otherwise-valid files.
LOCK_FILE="$(
  "$NODE_BIN" --input-type=module -e "
    import { loadContinuousDeploymentPolicy } from '$ROOT/scripts/lib/release-manifest.mjs';
    process.stdout.write(loadContinuousDeploymentPolicy('$ROOT').paths.lockFile);
  "
)"
if [ -z "$LOCK_FILE" ]; then
  echo "could not resolve the release lock file from the deployment policy" >&2
  exit 1
fi

if [ ! -x "$FLOCK_BIN" ]; then
  echo "util-linux flock is required at $FLOCK_BIN to serialize releases" >&2
  exit 1
fi

install -d -m 700 "$(dirname "$LOCK_FILE")"
: >>"$LOCK_FILE"
chmod 600 "$LOCK_FILE"
[ -f "$LOCK_FILE" ] && [ ! -L "$LOCK_FILE" ] \
  && [ "$(stat -c '%U:%G:%a:%h:%s' -- "$LOCK_FILE")" = 'root:root:600:1:0' ] \
  || die "release lock owner, mode, link count, size, or type is unsafe"

# LOCK ORDER (the single documented order for this host):
#   1. the CD release lock          — serializes releases against each other
#   2. the shared maintenance mutex — serializes releases against the retained
#                                     root maintenance transactions
#
# The legacy root maintenance scripts (chat-capability flag transactions,
# routing-calibration export, ollama finalization, legacy retirement) take the
# same maintenance mutex, so container releases and those paths cannot overlap
# during the PM2 transition. Its filename is historical; what it protects is root
# maintenance, not SonarQube.
#
# Both are --nonblock: a contended poll exits 75 and the 30s timer retries,
# rather than queueing pollers behind a long maintenance transaction.
MAINTENANCE_LOCK="$(
  "$NODE_BIN" --input-type=module -e "
    import { loadContinuousDeploymentPolicy } from '$ROOT/scripts/lib/release-manifest.mjs';
    process.stdout.write(loadContinuousDeploymentPolicy('$ROOT').paths.maintenanceLockFile ?? '');
  "
)"
if [ -z "$MAINTENANCE_LOCK" ]; then
  echo "could not resolve the shared maintenance mutex from the deployment policy" >&2
  exit 1
fi
[ -f "$MAINTENANCE_LOCK" ] && [ ! -L "$MAINTENANCE_LOCK" ] \
  && [ "$(stat -c '%U:%G:%a' -- "$MAINTENANCE_LOCK")" = 'root:dominguez:660' ] \
  || die "shared maintenance mutex owner, mode, or type is unsafe"

exec 9<>"$LOCK_FILE"
assert_lock_fd_matches_path 9 "$LOCK_FILE"
"$FLOCK_BIN" --nonblock --conflict-exit-code 75 9
assert_lock_fd_matches_path 9 "$LOCK_FILE"
exec 8<>"$MAINTENANCE_LOCK"
assert_lock_fd_matches_path 8 "$MAINTENANCE_LOCK"
"$FLOCK_BIN" --nonblock --conflict-exit-code 75 8
assert_lock_fd_matches_path 8 "$MAINTENANCE_LOCK"

# Export serialization evidence only after both governed locks are acquired and
# identity-reasserted. The discovery-alert store binds inherited fd 9 back to
# the policy lock path before every state read or write.
export NEXUS_RELEASE_LOCK_HELD=1
export NEXUS_RELEASE_LOCK_FD=9

assert_pm2_guard

exec "$NODE_BIN" "$ROOT/scripts/release-deploy.mjs" "$@"
