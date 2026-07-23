#!/usr/bin/env bash
# Read-only ServerDominguez capacity and network snapshot for the advisory
# SonarQube/Docker decision. Apart from its private evidence directory, this
# script never writes host configuration or restarts a service.
set -euo pipefail
umask 077

OUTPUT=""
SAMPLE_SECONDS=10
MIN_AVAILABLE_GIB=16
MIN_DISK_FREE_PERCENT=20
EXPECTED_HOST="${SONAR_EXPECTED_HOST:-serverdominguez}"
PM2_BIN="${PM2_BIN:-/home/dominguez/.npm-global/bin/pm2}"
CURL_BIN="$(command -v curl 2>/dev/null || true)"
NODE_BIN="$(command -v node 2>/dev/null || true)"
HEALTH_URLS=(http://127.0.0.1:8200/health http://127.0.0.1:8201/health)

usage() {
  cat <<'EOF'
Usage: quality-sonar-preflight.sh --output <absolute-private-dir> [options]
  --sample-seconds <0-60>       Observation window for swap and PM2 stability.
  --min-available-gib <16-30>   Minimum MemAvailable; default 16 GiB.
  --min-disk-free-percent <20-90>
  --pm2-bin <absolute-path>
  --health-url <loopback-url>   Replaces default URLs on first use; repeatable.
EOF
}

custom_health=false
while [ $# -gt 0 ]; do
  case "$1" in
    --output) OUTPUT="$2"; shift 2 ;;
    --sample-seconds) SAMPLE_SECONDS="$2"; shift 2 ;;
    --min-available-gib) MIN_AVAILABLE_GIB="$2"; shift 2 ;;
    --min-disk-free-percent) MIN_DISK_FREE_PERCENT="$2"; shift 2 ;;
    --pm2-bin) PM2_BIN="$2"; shift 2 ;;
    --health-url)
      if [ "$custom_health" = false ]; then HEALTH_URLS=(); custom_health=true; fi
      HEALTH_URLS+=("$2"); shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 64 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "Preflight requires root so firewall evidence is complete" >&2; exit 1; }
[[ "$OUTPUT" == /* ]] && [ "$OUTPUT" != / ] || { echo "--output must be a safe absolute directory" >&2; exit 64; }
[ ! -e "$OUTPUT" ] || { echo "Preflight output already exists: $OUTPUT" >&2; exit 1; }
[[ "$SAMPLE_SECONDS" =~ ^[0-9]+$ ]] && [ "$SAMPLE_SECONDS" -le 60 ] || { echo "Invalid sample interval" >&2; exit 64; }
[[ "$MIN_AVAILABLE_GIB" =~ ^[0-9]+$ ]] && [ "$MIN_AVAILABLE_GIB" -ge 16 ] && [ "$MIN_AVAILABLE_GIB" -le 30 ] || { echo "Invalid memory floor" >&2; exit 64; }
[[ "$MIN_DISK_FREE_PERCENT" =~ ^[0-9]+$ ]] && [ "$MIN_DISK_FREE_PERCENT" -ge 20 ] && [ "$MIN_DISK_FREE_PERCENT" -le 90 ] || { echo "Invalid disk floor" >&2; exit 64; }
[[ "$PM2_BIN" == /* ]] && [ -x "$PM2_BIN" ] || { echo "PM2 binary is unavailable" >&2; exit 1; }
[ -x "$CURL_BIN" ] && [ -x "$NODE_BIN" ] || { echo "curl and node are required" >&2; exit 1; }
observed_host="$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')"
[ "$observed_host" = "$EXPECTED_HOST" ] || { echo "Preflight must run on $EXPECTED_HOST (observed $observed_host)" >&2; exit 1; }
boot_id="$(tr -d '\r\n' </proc/sys/kernel/random/boot_id 2>/dev/null || true)"
[[ "$boot_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || { echo "Unable to read the current Linux boot ID" >&2; exit 1; }
for url in "${HEALTH_URLS[@]}"; do
  case "$url" in http://127.0.0.1:*/*|http://localhost:*/*) ;; *) echo "Health snapshots must use loopback URLs" >&2; exit 64 ;; esac
done

mkdir -m 0700 -p "$OUTPUT"
failures_file="$OUTPUT/failures.txt"
: >"$failures_file"
chmod 0600 "$failures_file"

record_failure() {
  printf '%s\n' "$1" >>"$failures_file"
}

capture_or_mark() {
  local file="$1"; shift
  if "$@" >"$OUTPUT/$file" 2>&1; then
    chmod 0600 "$OUTPUT/$file"
  else
    printf 'capture_unavailable command=%s\n' "$1" >"$OUTPUT/$file"
    chmod 0600 "$OUTPUT/$file"
    record_failure "snapshot_unavailable:$file"
  fi
}

firewall_backend_count=0
capture_firewall_backend() {
  local file="$1" command="$2"; shift 2
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'backend=not_installed command=%s\n' "$command" >"$OUTPUT/$file"
  elif "$command" "$@" >"$OUTPUT/$file" 2>&1; then
    firewall_backend_count=$((firewall_backend_count + 1))
  else
    printf 'backend=capture_failed command=%s\n' "$command" >"$OUTPUT/$file"
  fi
  chmod 0600 "$OUTPUT/$file"
}

capture_firewall_backend firewall-ufw.txt ufw status verbose
capture_firewall_backend firewall-nft.txt nft list ruleset
capture_firewall_backend firewall-iptables.txt iptables-save
[ "$firewall_backend_count" -gt 0 ] || record_failure no_authoritative_firewall_backend_snapshot
capture_or_mark listeners.txt ss -ltnp
capture_or_mark sysctl.txt sysctl vm.max_map_count fs.file-max net.ipv4.ip_forward
capture_routes() {
  ip -details rule show
  ip route show table all
}
capture_or_mark routes.txt capture_routes

{
  systemctl show tailscaled -p ActiveState -p SubState -p NRestarts --no-pager 2>/dev/null || true
  printf 'tailscaleProcessCount=%s\n' "$(ps -eo comm= | awk '$1 == "tailscaled" { n++ } END { print n + 0 }')"
} >"$OUTPUT/tailscale.txt"
{
  systemctl show cloudflared -p ActiveState -p SubState -p NRestarts --no-pager 2>/dev/null || true
  printf 'cloudflaredProcessCount=%s\n' "$(ps -eo comm= | awk '$1 == "cloudflared" { n++ } END { print n + 0 }')"
} >"$OUTPUT/cloudflare.txt"
chmod 0600 "$OUTPUT/tailscale.txt" "$OUTPUT/cloudflare.txt"

if command -v docker >/dev/null 2>&1; then
  docker version --format 'client={{.Client.Version}} server={{.Server.Version}}' >"$OUTPUT/docker.txt" 2>&1 || record_failure docker_version_unavailable
else
  printf 'docker=not_installed\n' >"$OUTPUT/docker.txt"
fi
chmod 0600 "$OUTPUT/docker.txt"

available_kib="$(awk '/^MemAvailable:/ { print $2; exit }' /proc/meminfo)"
required_kib=$((MIN_AVAILABLE_GIB * 1024 * 1024))
[[ "$available_kib" =~ ^[0-9]+$ ]] || { echo "Unable to read MemAvailable" >&2; exit 1; }
[ "$available_kib" -ge "$required_kib" ] || record_failure "memory_available_below_${MIN_AVAILABLE_GIB}GiB"

load_15_milli="$(awk '{ printf "%d", ($3 * 1000) + 0.5 }' /proc/loadavg)"
[[ "$load_15_milli" =~ ^[0-9]+$ ]] || { echo "Unable to read 15-minute load" >&2; exit 1; }
[ "$load_15_milli" -lt 6000 ] || record_failure "load_15_at_or_above_6"

disk_used_percent="$(df -P / | awk 'NR == 2 { gsub(/%/, "", $5); print $5 }')"
[[ "$disk_used_percent" =~ ^[0-9]+$ ]] || { echo "Unable to read root disk usage" >&2; exit 1; }
disk_free_percent=$((100 - disk_used_percent))
[ "$disk_free_percent" -ge "$MIN_DISK_FREE_PERCENT" ] || record_failure "disk_free_below_${MIN_DISK_FREE_PERCENT}_percent"

max_map_count="$(sysctl -n vm.max_map_count)"
file_max="$(sysctl -n fs.file-max)"
[ "$max_map_count" -ge 524288 ] || record_failure vm_max_map_count_below_524288
[ "$file_max" -ge 131072 ] || record_failure fs_file_max_below_131072

if ss -ltnH 'sport = :9000' | grep -q .; then
  record_failure port_9000_already_in_use
fi

oom_count=0
if command -v journalctl >/dev/null 2>&1; then
  oom_count="$(journalctl -k --since '-24 hours' --no-pager 2>/dev/null | grep -Eic 'Out of memory|oom-kill|Killed process' || true)"
else
  record_failure kernel_journal_unavailable
fi
[ "$oom_count" -eq 0 ] || record_failure "kernel_oom_events_last_24h:$oom_count"

pm2_snapshot() {
  "$PM2_BIN" jlist | "$NODE_BIN" -e '
    let raw="";
    process.stdin.on("data", d => raw += d).on("end", () => {
      const expected = ["nexus-hub", "content-engine", "nexus-hub-staging", "content-engine-staging"];
      const rows = JSON.parse(raw || "[]");
      const services = expected.map(name => {
        const found = rows.filter(row => row?.name === name);
        if (found.length !== 1) throw new Error(`expected exactly one ${name}`);
        const env = found[0].pm2_env || {};
        return {
          name,
          status: env.status || null,
          restartTime: Number(env.restart_time || 0),
          unstableRestarts: Number(env.unstable_restarts || 0),
        };
      });
      process.stdout.write(`${JSON.stringify({ services }, null, 2)}\n`);
    });'
}

pm2_snapshot >"$OUTPUT/pm2-before.json" || record_failure pm2_before_snapshot_failed
chmod 0600 "$OUTPUT/pm2-before.json"

read_swap_counter() {
  awk -v key="$1" '$1 == key { print $2; exit }' /proc/vmstat
}
swap_in_before="$(read_swap_counter pswpin)"
swap_out_before="$(read_swap_counter pswpout)"
[ "$SAMPLE_SECONDS" -eq 0 ] || sleep "$SAMPLE_SECONDS"
swap_in_after="$(read_swap_counter pswpin)"
swap_out_after="$(read_swap_counter pswpout)"
swap_in_delta=$((swap_in_after - swap_in_before))
swap_out_delta=$((swap_out_after - swap_out_before))
[ "$swap_in_delta" -eq 0 ] && [ "$swap_out_delta" -eq 0 ] || record_failure "active_swap_io:in=$swap_in_delta,out=$swap_out_delta"

pm2_snapshot >"$OUTPUT/pm2-after.json" || record_failure pm2_after_snapshot_failed
chmod 0600 "$OUTPUT/pm2-after.json"
if [ -s "$OUTPUT/pm2-before.json" ] && [ -s "$OUTPUT/pm2-after.json" ]; then
  "$NODE_BIN" - "$OUTPUT/pm2-before.json" "$OUTPUT/pm2-after.json" <<'NODE' || record_failure pm2_restart_or_status_regression
const fs = require('fs');
const [beforePath, afterPath] = process.argv.slice(2);
const before = JSON.parse(fs.readFileSync(beforePath, 'utf8')).services;
const after = JSON.parse(fs.readFileSync(afterPath, 'utf8')).services;
for (const row of after) {
  const prior = before.find(item => item.name === row.name);
  if (!prior || row.status !== 'online' || prior.status !== 'online') process.exit(1);
  if (row.restartTime !== prior.restartTime || row.unstableRestarts !== prior.unstableRestarts) process.exit(1);
}
NODE
fi

health_index=0
: >"$OUTPUT/health.tsv"
for url in "${HEALTH_URLS[@]}"; do
  health_index=$((health_index + 1))
  body="$OUTPUT/.health-$health_index.body"
  if ! code="$($CURL_BIN --silent --show-error --connect-timeout 2 --max-time 8 -o "$body" -w '%{http_code}' "$url" 2>/dev/null)"; then
    code=000
  fi
  digest=unavailable
  bytes=0
  if [ -f "$body" ]; then
    digest="$(sha256sum "$body" | awk '{ print $1 }')"
    bytes="$(wc -c <"$body" | tr -d ' ')"
    rm -f "$body"
  fi
  printf '%s\t%s\t%s\t%s\n' "$url" "$code" "$bytes" "$digest" >>"$OUTPUT/health.tsv"
  case "$code" in 2??) ;; *) record_failure "health_probe_failed:$url:$code" ;; esac
done
chmod 0600 "$OUTPUT/health.tsv"

cat >"$OUTPUT/capacity.env" <<EOF
MEM_AVAILABLE_KIB=$available_kib
MIN_AVAILABLE_GIB=$MIN_AVAILABLE_GIB
DISK_FREE_PERCENT=$disk_free_percent
MIN_DISK_FREE_PERCENT=$MIN_DISK_FREE_PERCENT
VM_MAX_MAP_COUNT=$max_map_count
FS_FILE_MAX=$file_max
SWAP_IN_DELTA_PAGES=$swap_in_delta
SWAP_OUT_DELTA_PAGES=$swap_out_delta
OOM_EVENTS_LAST_24H=$oom_count
LOAD_15_MILLI=$load_15_milli
SAMPLE_SECONDS=$SAMPLE_SECONDS
EOF
chmod 0600 "$OUTPUT/capacity.env"

find "$OUTPUT" -maxdepth 1 -type f ! -name checksums.sha256 -print0 \
  | sort -z | xargs -0 sha256sum >"$OUTPUT/checksums.sha256"
chmod 0600 "$OUTPUT/checksums.sha256"

failure_count="$(grep -c . "$failures_file" || true)"
if [ "$failure_count" -ne 0 ]; then
  echo "Sonar host preflight failed ($failure_count checks); private evidence: $OUTPUT" >&2
  exit 1
fi
evidence_tool="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/quality-sonar-start-evidence.mjs"
[ -x "$evidence_tool" ] || evidence_tool=/usr/local/sbin/quality-sonar-start-evidence.mjs
[ -x "$evidence_tool" ] || { echo "Sonar start-evidence recorder is unavailable" >&2; exit 1; }
"$evidence_tool" record-preflight \
  --directory "$OUTPUT" \
  --host "$EXPECTED_HOST" \
  --boot-id "$boot_id"
echo "sonar_host_preflight_ok memoryFloorGiB=$MIN_AVAILABLE_GIB diskFloorPercent=$MIN_DISK_FREE_PERCENT evidence=$OUTPUT/result.json"
