#!/usr/bin/env bash
# Fail closed when the shared release host does not have enough quiet headroom
# for staging or production promotion. Output contains aggregate facts only.
set -euo pipefail
umask 077

ROLE=""
BASE_DIR=""
PM2_BIN=""
SONAR_URL="${NEXUS_SONAR_URL:-http://127.0.0.1:9000}"
SONAR_STATE_HELPER="${NEXUS_SONAR_STATE_HELPER:-/usr/local/sbin/quality-sonar-release-state}"
SONAR_PROJECT_KEY="${NEXUS_SONAR_PROJECT_KEY:-nexus-hub-backend}"
SUDO_BIN="${NEXUS_RELEASE_SUDO_BIN:-/usr/bin/sudo}"
SAMPLE_SECONDS="${NEXUS_RELEASE_CAPACITY_SAMPLE_SECONDS:-10}"
FIXTURE_ROOT=""

MIN_AVAILABLE_KIB=$((12 * 1024 * 1024))
MIN_DISK_AVAILABLE_KIB=$((20 * 1024 * 1024))
MIN_DISK_AVAILABLE_PERCENT=15
MIN_INODE_AVAILABLE_PERCENT=10
MAX_LOAD15=6

usage() {
  echo "Usage: remote-release-capacity.sh --role <staging|production> --base-dir <path> --pm2-bin <path> [--sonar-url <url>] [--sonar-state-helper <path>] [--sample-seconds <seconds>]"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --role) ROLE="$2"; shift 2 ;;
    --base-dir) BASE_DIR="$2"; shift 2 ;;
    --pm2-bin) PM2_BIN="$2"; shift 2 ;;
    --sonar-url) SONAR_URL="$2"; shift 2 ;;
    --sonar-state-helper) SONAR_STATE_HELPER="$2"; shift 2 ;;
    --sample-seconds) SAMPLE_SECONDS="$2"; shift 2 ;;
    --fixture-root) FIXTURE_ROOT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 64 ;;
  esac
done

case "$ROLE" in staging|production) ;; *) echo "invalid release capacity role" >&2; exit 64 ;; esac
[[ "$BASE_DIR" == /home/dominguez/* ]] || {
  if [ -z "$FIXTURE_ROOT" ]; then echo "unsafe release capacity base path" >&2; exit 64; fi
}
[[ "$SONAR_URL" =~ ^https?://(127\.0\.0\.1|localhost)(:[0-9]+)?$ ]] || {
  echo "SonarQube capacity endpoint must be loopback-only" >&2
  exit 64
}
[ "$SONAR_PROJECT_KEY" = nexus-hub-backend ] || { echo "invalid SonarQube release project" >&2; exit 64; }
if [ "$SONAR_STATE_HELPER" != /usr/local/sbin/quality-sonar-release-state ] \
    && [ "${NEXUS_RELEASE_TEST_MODE:-0}" != "1" ]; then
  echo "unsafe SonarQube release-state helper" >&2
  exit 64
fi
[[ "$SAMPLE_SECONDS" =~ ^[0-9]+$ ]] || { echo "invalid capacity sample interval" >&2; exit 64; }
if [ -n "$FIXTURE_ROOT" ]; then
  [ "${NEXUS_RELEASE_TEST_MODE:-0}" = "1" ] || { echo "capacity fixtures are test-only" >&2; exit 64; }
  [ -d "$FIXTURE_ROOT" ] || { echo "capacity fixture root is missing" >&2; exit 64; }
else
  [ "$SAMPLE_SECONDS" -ge 5 ] && [ "$SAMPLE_SECONDS" -le 60 ] || {
    echo "capacity sample interval must be between 5 and 60 seconds" >&2
    exit 64
  }
  [ -d "$BASE_DIR" ] || { echo "release capacity base path is missing" >&2; exit 1; }
  [ -x "$PM2_BIN" ] || { echo "PM2 is unavailable for release capacity proof" >&2; exit 1; }
fi

reasons=()

if [ -n "$FIXTURE_ROOT" ]; then
  MEMINFO="$FIXTURE_ROOT/meminfo"
  LOADAVG="$FIXTURE_ROOT/loadavg"
  DF_BLOCKS="$FIXTURE_ROOT/df-blocks"
  DF_INODES="$FIXTURE_ROOT/df-inodes"
  KERNEL_LOG="$FIXTURE_ROOT/journal.log"
  PM2_BEFORE="$FIXTURE_ROOT/pm2-before.json"
  PM2_AFTER="$FIXTURE_ROOT/pm2-after.json"
  VMSTAT_BEFORE="$FIXTURE_ROOT/vmstat-before"
  VMSTAT_AFTER="$FIXTURE_ROOT/vmstat-after"
else
  MEMINFO="$(mktemp)"
  LOADAVG="$(mktemp)"
  DF_BLOCKS="$(mktemp)"
  DF_INODES="$(mktemp)"
  KERNEL_LOG="$(mktemp)"
  PM2_BEFORE="$(mktemp)"
  PM2_AFTER="$(mktemp)"
  VMSTAT_BEFORE="$(mktemp)"
  VMSTAT_AFTER="$(mktemp)"
  cleanup_capacity_files() {
    rm -f "$MEMINFO" "$LOADAVG" "$DF_BLOCKS" "$DF_INODES" "$KERNEL_LOG" "$PM2_BEFORE" "$PM2_AFTER" \
      "$VMSTAT_BEFORE" "$VMSTAT_AFTER" \
      "${SONAR_SYSTEM_BODY:-}" "${SONAR_HELPER_BODY:-}"
  }
  trap cleanup_capacity_files EXIT
  cp /proc/meminfo "$MEMINFO"
  cp /proc/loadavg "$LOADAVG"
  df -Pk "$BASE_DIR" > "$DF_BLOCKS"
  df -Pi "$BASE_DIR" > "$DF_INODES"
  if ! journalctl -k -b --since '-30 minutes' --no-pager -o cat > "$KERNEL_LOG" 2>/dev/null; then
    reasons+=("kernel_oom_history_unavailable")
    : > "$KERNEL_LOG"
  fi
  "$PM2_BIN" jlist > "$PM2_BEFORE"
  cp /proc/vmstat "$VMSTAT_BEFORE"
  sleep "$SAMPLE_SECONDS"
  "$PM2_BIN" jlist > "$PM2_AFTER"
  cp /proc/vmstat "$VMSTAT_AFTER"
fi

for required in "$MEMINFO" "$LOADAVG" "$DF_BLOCKS" "$DF_INODES" "$KERNEL_LOG" "$PM2_BEFORE" "$PM2_AFTER" \
    "$VMSTAT_BEFORE" "$VMSTAT_AFTER"; do
  [ -f "$required" ] || { echo "release capacity input is missing" >&2; exit 1; }
done

MEM_AVAILABLE_KIB="$(awk '$1=="MemAvailable:" {print $2; exit}' "$MEMINFO")"
SWAP_TOTAL_KIB="$(awk '$1=="SwapTotal:" {print $2; exit}' "$MEMINFO")"
SWAP_FREE_KIB="$(awk '$1=="SwapFree:" {print $2; exit}' "$MEMINFO")"
LOAD15="$(awk '{print $3}' "$LOADAVG")"
read -r DISK_AVAILABLE_KIB DISK_AVAILABLE_PERCENT < <(awk 'NR==2 {gsub(/%/,"",$5); print $4, 100-$5}' "$DF_BLOCKS")
INODE_AVAILABLE_PERCENT="$(awk 'NR==2 {gsub(/%/,"",$5); print 100-$5}' "$DF_INODES")"

[[ "$MEM_AVAILABLE_KIB" =~ ^[0-9]+$ ]] || reasons+=("memory_available_unreadable")
[[ "$SWAP_TOTAL_KIB" =~ ^[0-9]+$ ]] || reasons+=("swap_total_unreadable")
[[ "$SWAP_FREE_KIB" =~ ^[0-9]+$ ]] || reasons+=("swap_free_unreadable")
[[ "$DISK_AVAILABLE_KIB" =~ ^[0-9]+$ ]] || reasons+=("disk_available_unreadable")
[[ "$DISK_AVAILABLE_PERCENT" =~ ^[0-9]+$ ]] || reasons+=("disk_percent_unreadable")
[[ "$INODE_AVAILABLE_PERCENT" =~ ^[0-9]+$ ]] || reasons+=("inode_percent_unreadable")
[[ "$LOAD15" =~ ^[0-9]+([.][0-9]+)?$ ]] || reasons+=("load15_unreadable")

if [[ "$MEM_AVAILABLE_KIB" =~ ^[0-9]+$ ]] && [ "$MEM_AVAILABLE_KIB" -lt "$MIN_AVAILABLE_KIB" ]; then
  reasons+=("memory_available_below_12_gib")
fi
PSWPIN_BEFORE="$(awk '$1=="pswpin" {print $2; exit}' "$VMSTAT_BEFORE")"
PSWPIN_AFTER="$(awk '$1=="pswpin" {print $2; exit}' "$VMSTAT_AFTER")"
PSWPOUT_BEFORE="$(awk '$1=="pswpout" {print $2; exit}' "$VMSTAT_BEFORE")"
PSWPOUT_AFTER="$(awk '$1=="pswpout" {print $2; exit}' "$VMSTAT_AFTER")"
for value in "$PSWPIN_BEFORE" "$PSWPIN_AFTER" "$PSWPOUT_BEFORE" "$PSWPOUT_AFTER"; do
  [[ "$value" =~ ^[0-9]+$ ]] || reasons+=("swap_io_counters_unreadable")
done
PSWPIN_DELTA=-1; PSWPOUT_DELTA=-1
if [[ "$PSWPIN_BEFORE" =~ ^[0-9]+$ && "$PSWPIN_AFTER" =~ ^[0-9]+$ \
    && "$PSWPOUT_BEFORE" =~ ^[0-9]+$ && "$PSWPOUT_AFTER" =~ ^[0-9]+$ ]]; then
  if [ "$PSWPIN_AFTER" -lt "$PSWPIN_BEFORE" ] || [ "$PSWPOUT_AFTER" -lt "$PSWPOUT_BEFORE" ]; then
    reasons+=("swap_io_counters_reset")
  else
    PSWPIN_DELTA=$((PSWPIN_AFTER - PSWPIN_BEFORE))
    PSWPOUT_DELTA=$((PSWPOUT_AFTER - PSWPOUT_BEFORE))
    [ "$PSWPIN_DELTA" -eq 0 ] || reasons+=("sustained_swap_in_observed")
    [ "$PSWPOUT_DELTA" -eq 0 ] || reasons+=("sustained_swap_out_observed")
  fi
fi
if [[ "$LOAD15" =~ ^[0-9]+([.][0-9]+)?$ ]] \
    && ! awk -v value="$LOAD15" -v ceiling="$MAX_LOAD15" 'BEGIN { exit value < ceiling ? 0 : 1 }'; then
  reasons+=("load15_at_or_above_6")
fi
if [[ "$DISK_AVAILABLE_KIB" =~ ^[0-9]+$ ]] && [ "$DISK_AVAILABLE_KIB" -lt "$MIN_DISK_AVAILABLE_KIB" ]; then
  reasons+=("disk_available_below_20_gib")
fi
if [[ "$DISK_AVAILABLE_PERCENT" =~ ^[0-9]+$ ]] && [ "$DISK_AVAILABLE_PERCENT" -lt "$MIN_DISK_AVAILABLE_PERCENT" ]; then
  reasons+=("disk_available_below_15_percent")
fi
if [[ "$INODE_AVAILABLE_PERCENT" =~ ^[0-9]+$ ]] && [ "$INODE_AVAILABLE_PERCENT" -lt "$MIN_INODE_AVAILABLE_PERCENT" ]; then
  reasons+=("inode_available_below_10_percent")
fi
if rg -i -q 'out of memory|oom-kill|killed process [0-9]+ .*total-vm' "$KERNEL_LOG" 2>/dev/null \
    || grep -Eiq 'out of memory|oom-kill|killed process [0-9]+ .*total-vm' "$KERNEL_LOG"; then
  reasons+=("kernel_oom_observed_last_30_minutes")
fi

PM2_RESULT="$(node - "$PM2_BEFORE" "$PM2_AFTER" <<'NODE'
const fs = require('fs');
const [beforePath, afterPath] = process.argv.slice(2);
const before = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
const after = JSON.parse(fs.readFileSync(afterPath, 'utf8'));
// ServerDominguez is shared: a staging release must not proceed while
// production is unstable, and production promotion must not hide a staging
// regression. Prove all four supervised services over the same sample window.
const names = [
  'nexus-hub',
  'content-engine',
  'nexus-hub-staging',
  'content-engine-staging',
];
const failures = [];
const counters = {};
for (const name of names) {
  const first = before.find((entry) => entry?.name === name);
  const second = after.find((entry) => entry?.name === name);
  if (!first || !second) {
    failures.push(`pm2_process_missing:${name}`);
    continue;
  }
  const a = Number(first.pm2_env?.restart_time ?? -1);
  const b = Number(second.pm2_env?.restart_time ?? -1);
  const unstableA = Number(first.pm2_env?.unstable_restarts ?? 0);
  const unstableB = Number(second.pm2_env?.unstable_restarts ?? 0);
  counters[name] = { before: a, after: b };
  if (first.pm2_env?.status !== 'online' || second.pm2_env?.status !== 'online') {
    failures.push(`pm2_process_not_stably_online:${name}`);
  }
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a !== b) {
    failures.push(`pm2_restart_observed:${name}`);
  }
  if (unstableA !== 0 || unstableB !== 0) failures.push(`pm2_unstable_restart_observed:${name}`);
}
process.stdout.write(JSON.stringify({ failures, counters }));
NODE
)" || { echo "PM2 capacity evidence is invalid" >&2; exit 1; }
while IFS= read -r reason; do
  [ -z "$reason" ] || reasons+=("$reason")
done < <(printf '%s' "$PM2_RESULT" | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{for(const x of JSON.parse(b).failures)console.log(x)})')

SONAR_ACTIVE_TASKS=0
if [ -n "$FIXTURE_ROOT" ]; then
  if [ -f "$FIXTURE_ROOT/sonar-helper-unavailable" ]; then
    reasons+=("sonar_release_state_helper_unavailable")
  else
    for status in in-progress pending; do
      file="$FIXTURE_ROOT/sonar-$status.json"
      [ -f "$file" ] || { echo "SonarQube capacity fixture is missing" >&2; exit 1; }
      count="$(node -e 'const x=require(process.argv[1]);process.stdout.write(String(x.paging?.total??x.tasks?.length??0))' "$file")"
      [[ "$count" =~ ^[0-9]+$ ]] || { echo "SonarQube task count is invalid" >&2; exit 1; }
      SONAR_ACTIVE_TASKS=$((SONAR_ACTIVE_TASKS + count))
    done
  fi
else
  SONAR_SYSTEM_BODY="$(mktemp)"
  SONAR_HELPER_BODY="$(mktemp)"
  set +e
  sonar_system_code="$(curl --silent --show-error --connect-timeout 2 --max-time 5 \
    --output "$SONAR_SYSTEM_BODY" --write-out '%{http_code}' "$SONAR_URL/api/system/status" 2>/dev/null)"
  sonar_system_exit=$?
  set -e
  if [ "$sonar_system_exit" -eq 0 ]; then
    if [ "$sonar_system_code" != "200" ]; then
      reasons+=("sonar_status_unavailable_http_${sonar_system_code}")
    else
      sonar_status="$(node -e 'const x=require(process.argv[1]);process.stdout.write(String(x.status||""))' "$SONAR_SYSTEM_BODY" 2>/dev/null || true)"
      if [ "$sonar_status" != "UP" ]; then reasons+=("sonar_not_up:${sonar_status:-unknown}"); fi
      set +e
      "$SUDO_BIN" -n "$SONAR_STATE_HELPER" --project nexus-hub-backend --json > "$SONAR_HELPER_BODY" 2>/dev/null
      sonar_helper_exit=$?
      set -e
      if [ "$sonar_helper_exit" -ne 0 ]; then
        reasons+=("sonar_release_state_helper_unavailable")
      else
        helper_count="$(node -e '
          const x=require(process.argv[1]);
          if(x.schema!=="nexus.sonarqube-release-state.v1"||x.status!=="passed"
              ||x.projectKey!=="nexus-hub-backend"||!Number.isInteger(x.activeTasks)||x.activeTasks<0)process.exit(1);
          process.stdout.write(String(x.activeTasks));' "$SONAR_HELPER_BODY" 2>/dev/null || true)"
        if [[ "$helper_count" =~ ^[0-9]+$ ]]; then
          SONAR_ACTIVE_TASKS="$helper_count"
        else
          reasons+=("sonar_release_state_helper_invalid")
        fi
      fi
    fi
  elif [ "$sonar_system_exit" -ne 7 ]; then
    reasons+=("sonar_status_probe_failed")
  fi
fi
if [ "$SONAR_ACTIVE_TASKS" -ne 0 ]; then reasons+=("sonar_ce_task_active"); fi

REASONS_JSON="$(printf '%s\n' "${reasons[@]:-}" | node -e '
let body="";process.stdin.on("data",c=>body+=c);process.stdin.on("end",()=>{
  process.stdout.write(JSON.stringify(body.split(/\r?\n/u).filter(Boolean)));
});')"
node - "$ROLE" "$MEM_AVAILABLE_KIB" "$LOAD15" "$DISK_AVAILABLE_KIB" \
  "$DISK_AVAILABLE_PERCENT" "$INODE_AVAILABLE_PERCENT" "$SWAP_TOTAL_KIB" "$SWAP_FREE_KIB" \
  "$PSWPIN_DELTA" "$PSWPOUT_DELTA" "$SONAR_ACTIVE_TASKS" "$SAMPLE_SECONDS" "$REASONS_JSON" <<'NODE'
const [role, memoryAvailableKiB, load15, diskAvailableKiB, diskAvailablePercent,
  inodeAvailablePercent, swapTotalKiB, swapFreeKiB, pswpinDelta, pswpoutDelta, sonarActiveTasks, sampleSeconds,
  reasonsJson] = process.argv.slice(2);
const reasons = JSON.parse(reasonsJson);
process.stdout.write(`${JSON.stringify({
  schema: 'nexus.release-host-capacity.v1',
  ok: reasons.length === 0,
  role,
  thresholds: {
    memoryAvailableGiB: 12,
    load15ExclusiveMaximum: 6,
    diskAvailableGiB: 20,
    diskAvailablePercent: 15,
    inodeAvailablePercent: 10,
    swapIoDelta: 0,
    sonarActiveTasks: 0,
  },
  observed: {
    memoryAvailableKiB: Number(memoryAvailableKiB || -1),
    load15: Number(load15 || -1),
    diskAvailableKiB: Number(diskAvailableKiB || -1),
    diskAvailablePercent: Number(diskAvailablePercent || -1),
    inodeAvailablePercent: Number(inodeAvailablePercent || -1),
    swapUsedKiB: Number(swapTotalKiB || 0) - Number(swapFreeKiB || 0),
    pswpinDelta: Number(pswpinDelta),
    pswpoutDelta: Number(pswpoutDelta),
    sonarActiveTasks: Number(sonarActiveTasks),
    pm2SampleSeconds: Number(sampleSeconds),
  },
  reasons,
}, null, 2)}\n`);
if (reasons.length) process.exitCode = 1;
NODE
