#!/usr/bin/env bash
# Root-only, non-mutating host admission check for a rollback-drill guest.
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

MIN_AVAILABLE_KIB=$((25 * 1024 * 1024))
MAX_LOAD15_MILLI=6000
MEMINFO_PATH=/proc/meminfo
LOADAVG_PATH=/proc/loadavg

die() {
  echo "rollback drill VM host preflight: $*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || die "must run as root through the reviewed systemd unit"
for command in grep id journalctl mktemp python3 rm; do
  command -v "$command" >/dev/null 2>&1 || die "$command is required"
done

python3 - \
  "$MIN_AVAILABLE_KIB" "$MAX_LOAD15_MILLI" \
  "$MEMINFO_PATH" "$LOADAVG_PATH" <<'PY' \
  || die "host capacity is below the rollback-drill admission floor"
import pathlib
import re
import sys

minimum_available_kib = int(sys.argv[1])
maximum_load15_milli = int(sys.argv[2])
meminfo = pathlib.Path(sys.argv[3]).read_text(encoding="ascii")
match = re.search(r"^MemAvailable:\s+([0-9]+)\s+kB$", meminfo, re.MULTILINE)
if match is None:
    raise SystemExit("MemAvailable is unavailable")
available_kib = int(match.group(1))
load_fields = pathlib.Path(sys.argv[4]).read_text(encoding="ascii").split()
if len(load_fields) < 3 or re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", load_fields[2]) is None:
    raise SystemExit("load-15 is unavailable")
load15_milli = round(float(load_fields[2]) * 1000)
if available_kib < minimum_available_kib:
    raise SystemExit(
        f"MemAvailable {available_kib} KiB is below {minimum_available_kib} KiB"
    )
if load15_milli >= maximum_load15_milli:
    raise SystemExit(
        f"load-15 {load15_milli / 1000:.3f} is at or above "
        f"{maximum_load15_milli / 1000:.3f}"
    )
PY

assert_no_recent_kernel_oom() {
  local grep_status kernel_history
  kernel_history="$(mktemp)" \
    || die "temporary kernel OOM history file is unavailable"
  trap 'rm -f -- "${kernel_history:-}"' EXIT RETURN
  if ! journalctl \
      -k \
      --since='24 hours ago' \
      --no-pager \
      --quiet \
      --output=cat \
      >"$kernel_history"; then
    rm -f -- "$kernel_history"
    die "kernel OOM history is unavailable"
  fi
  if grep -Eq \
    'Out of memory|oom-kill|Killed process|invoked oom-killer' \
    "$kernel_history"; then
    rm -f -- "$kernel_history"
    die "kernel OOM evidence exists in the last 24 hours"
  else
    grep_status=$?
  fi
  rm -f -- "$kernel_history"
  [ "$grep_status" -eq 1 ] || die "kernel OOM history scan failed"
  trap - EXIT RETURN
}
assert_no_recent_kernel_oom

printf '{"ok":true,"schema":"nexus.rollback-drill-vm-host-preflight.v1","minimumAvailableGiB":25,"maximumLoad15Exclusive":6,"kernelOomWindowHours":24}\n'
