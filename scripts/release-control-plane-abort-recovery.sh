#!/bin/bash -p
set -euo pipefail
umask 077
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

die() {
  printf 'CONTROL-PLANE ABORT RECOVERY REFUSED: %s\n' "$*" >&2
  exit 1
}

test "$EUID" -eq 0 || die 'run through sudo as root'
test "$#" -eq 14 || die 'seven exact owner-reviewed identity arguments are required'
test -x /usr/bin/flock || die '/usr/bin/flock is missing'
test -x /usr/bin/node || die '/usr/bin/node is missing'
test "$(/usr/bin/node --version)" = v22.23.1 \
  || die '/usr/bin/node is not exactly v22.23.1'

RECOVERY_SOURCE_SHA=
for ((index=1; index <= $#; index+=2)); do
  if test "${!index}" = --recovery-source-sha; then
    value_index=$((index + 1))
    RECOVERY_SOURCE_SHA="${!value_index}"
  fi
done
[[ "$RECOVERY_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] \
  || die 'recovery source SHA is missing or malformed'
EXPECTED_SCRIPT_DIR="/opt/nexus-release/recovery-tools/control-plane/$RECOVERY_SOURCE_SHA/scripts"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
test "$SCRIPT_DIR" = "$EXPECTED_SCRIPT_DIR" \
  || die 'recovery tool is not executing from its exact immutable source root'
WRAPPER="$SCRIPT_DIR/release-control-plane-abort-recovery.sh"
MODULE="$SCRIPT_DIR/release-control-plane-abort-recovery.mjs"
test -f "$WRAPPER" && test ! -L "$WRAPPER" \
  && case "$(stat -Lc '%U:%G:%a:%h' -- "$WRAPPER")" in
    root:root:555:1|root:root:755:1) true ;;
    *) false ;;
  esac || die 'recovery wrapper is not an exact root-owned executable'
test -f "$MODULE" && test ! -L "$MODULE" \
  && case "$(stat -Lc '%U:%G:%a:%h' -- "$MODULE")" in
    root:root:444:1|root:root:555:1|root:root:644:1) true ;;
    *) false ;;
  esac || die 'recovery module is not an exact root-owned file'

CONTROL_LOCK=/var/lib/nexus-release/locks/control-plane.lock
RELEASE_LOCK=/var/lib/nexus-release/locks/release.lock
MAINTENANCE_LOCK=/run/lock/nexus-release-sonar.lock
for lock in "$CONTROL_LOCK" "$RELEASE_LOCK"; do
  test -f "$lock" && test ! -L "$lock" \
    && test "$(stat -Lc '%U:%G:%a:%h' -- "$lock")" = root:root:600:1 \
    || die "governed lock is absent or unsafe: $lock"
done
DOMINGUEZ_GID="$(/usr/bin/id -g dominguez)"
[[ "$DOMINGUEZ_GID" =~ ^[0-9]+$ ]] || die 'dominguez group identity is unavailable'
test -f "$MAINTENANCE_LOCK" && test ! -L "$MAINTENANCE_LOCK" \
  && test "$(stat -Lc '%u:%g:%a:%h' -- "$MAINTENANCE_LOCK")" = \
    "0:$DOMINGUEZ_GID:660:1" \
  || die 'governed maintenance lock is absent or unsafe'

# This order is part of the recovery contract. The Node process inherits the
# same open file descriptions and re-binds all three descriptors to their names.
exec 7<>"$CONTROL_LOCK"
/usr/bin/flock -n 7 || die 'control-plane authority is active'
test "$(stat -Lc '%d:%i' -- /proc/$$/fd/7)" = "$(stat -Lc '%d:%i' -- "$CONTROL_LOCK")" \
  || die 'control-plane lock changed identity'
exec 9<>"$RELEASE_LOCK"
/usr/bin/flock -n 9 || die 'release authority is active'
test "$(stat -Lc '%d:%i' -- /proc/$$/fd/9)" = "$(stat -Lc '%d:%i' -- "$RELEASE_LOCK")" \
  || die 'release lock changed identity'
exec 8<>"$MAINTENANCE_LOCK"
/usr/bin/flock -n 8 || die 'root maintenance authority is active'
test "$(stat -Lc '%d:%i' -- /proc/$$/fd/8)" = \
  "$(stat -Lc '%d:%i' -- "$MAINTENANCE_LOCK")" \
  || die 'maintenance lock changed identity'

exec /usr/bin/env -i \
  PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  HOME=/var/lib/nexus-release/home \
  NODE_ENV=production \
  /usr/bin/node "$MODULE" "$@"
