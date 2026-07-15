#!/usr/bin/env bash
# Prove the exact runtime is healthy after PM2 start. Endpoint checks and PM2
# identity are deliberately independent, and two PM2 samples must remain stable.
set -euo pipefail
umask 077

ROLE=""
BASE_DIR=""
RELEASE_DIR=""
RUNTIME_SHA=""
PM2_BIN=""
NODE_BIN="/usr/bin/node"
CURL_BIN="$(command -v curl 2>/dev/null || true)"
OUTPUT=""
STABILITY_SECONDS=""

usage() {
  echo "Usage: remote-release-readiness.sh --role <staging|production> --base-dir <path> --release-dir <path> --runtime-sha <sha> --pm2-bin <path> --output <file> [--node-bin <path>] [--curl-bin <path>] [--stability-seconds <0-60>]"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --role) ROLE="$2"; shift 2 ;;
    --base-dir) BASE_DIR="$2"; shift 2 ;;
    --release-dir) RELEASE_DIR="$2"; shift 2 ;;
    --runtime-sha) RUNTIME_SHA="$2"; shift 2 ;;
    --pm2-bin) PM2_BIN="$2"; shift 2 ;;
    --node-bin) NODE_BIN="$2"; shift 2 ;;
    --curl-bin) CURL_BIN="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    --stability-seconds) STABILITY_SECONDS="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 64 ;;
  esac
done

case "$ROLE" in staging|production) ;; *) echo "invalid readiness role" >&2; exit 64 ;; esac
[[ "$BASE_DIR" == /* && "$RELEASE_DIR" == "$BASE_DIR"/releases/* ]] || { echo "unsafe readiness path" >&2; exit 64; }
[[ "$RUNTIME_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid readiness runtime SHA" >&2; exit 64; }
[ -x "$PM2_BIN" ] || { echo "PM2 is unavailable for readiness" >&2; exit 1; }
[ -x "$NODE_BIN" ] || { echo "Node is unavailable for readiness" >&2; exit 1; }
[ -x "$CURL_BIN" ] || { echo "curl is unavailable for readiness" >&2; exit 1; }
[ -n "$OUTPUT" ] || { echo "readiness output is required" >&2; exit 64; }
case "$STABILITY_SECONDS" in
  '') [ "$ROLE" = production ] && STABILITY_SECONDS=10 || STABILITY_SECONDS=5 ;;
  *[!0-9]*) echo "invalid stability seconds" >&2; exit 64 ;;
esac
[ "$STABILITY_SECONDS" -le 60 ] || { echo "stability seconds must not exceed 60" >&2; exit 64; }

if [ "$ROLE" = staging ]; then
  BACKEND_NAME="nexus-hub-staging"; CONTENT_NAME="content-engine-staging"
  BACKEND_PORT=8201; CONTENT_PORT=8101
else
  BACKEND_NAME="nexus-hub"; CONTENT_NAME="content-engine"
  BACKEND_PORT=8200; CONTENT_PORT=8100
fi

tmp_dir="$(mktemp -d)"
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT
chmod 700 "$tmp_dir"
backend_health="$tmp_dir/backend-health.json"
content_ready="$tmp_dir/content-ready.json"
content_header="$tmp_dir/content-header"
baseline="$tmp_dir/pm2-baseline.json"
final="$tmp_dir/pm2-final.json"
: > "$backend_health"
: > "$content_ready"
: > "$content_header"
: > "$baseline"
: > "$final"
chmod 600 "$backend_health" "$content_ready" "$content_header" "$baseline" "$final"

# This both loads the native addon with the exact runtime Node and checks the
# live database before release success can suppress automatic rollback.
"$NODE_BIN" - "$RELEASE_DIR" "$BASE_DIR/data/bot.db" <<'NODE'
const path = require('path');
const [releaseDir, dbPath] = process.argv.slice(2);
const Database = require(path.join(releaseDir, 'node_modules', 'better-sqlite3'));
const memory = new Database(':memory:');
memory.prepare('SELECT 1 AS ok').get();
memory.close();
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
try {
  const integrity = db.pragma('integrity_check');
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
    throw new Error('live database integrity_check failed');
  }
  const foreignKeys = db.pragma('foreign_key_check');
  if (foreignKeys.length !== 0) throw new Error('live database foreign_key_check failed');
} finally {
  db.close();
}
console.log('release_native_and_database_ok');
NODE

snapshot_pm2() {
  local output="$1"
  local raw="$tmp_dir/$(basename "$output").raw.json"
  "$PM2_BIN" jlist > "$raw"
  chmod 600 "$raw"
  "$NODE_BIN" - "$RELEASE_DIR" "$RUNTIME_SHA" "$BACKEND_NAME" "$CONTENT_NAME" "$output" "$raw" <<'NODE'
const fs = require('fs');
const [releaseDir, runtimeSha, backendName, contentName, output, raw] = process.argv.slice(2);
const rows = JSON.parse(fs.readFileSync(raw, 'utf8'));
const expected = new Map([
  [backendName, releaseDir],
  [contentName, `${releaseDir}/content-engine`],
]);
const services = [];
for (const [name, cwd] of expected) {
  const matches = rows.filter((entry) => entry?.name === name);
  if (matches.length !== 1) throw new Error(`PM2 readiness requires exactly one ${name} process`);
  const row = matches[0];
  const env = row.pm2_env || {};
  const observedSha = env.NEXUS_RELEASE_SHA || env.GIT_COMMIT || null;
  const observed = {
    name,
    status: env.status || null,
    cwd: env.pm_cwd || null,
    releaseSha: observedSha,
    pid: Number(row.pid || 0),
    restartTime: Number(env.restart_time || 0),
    unstableRestarts: Number(env.unstable_restarts || 0),
    uptime: Number(env.pm_uptime || 0),
  };
  if (observed.status !== 'online' || observed.cwd !== cwd || observed.releaseSha !== runtimeSha || observed.pid <= 0) {
    throw new Error(`PM2 exact identity mismatch: ${name}`);
  }
  for (const key of ['restartTime', 'unstableRestarts', 'uptime']) {
    if (!Number.isFinite(observed[key]) || observed[key] < 0) throw new Error(`invalid PM2 ${key}: ${name}`);
  }
  services.push(observed);
}
fs.writeFileSync(output, `${JSON.stringify({ services }, null, 2)}\n`, { mode: 0o600 });
NODE
}

snapshot_pm2 "$baseline"

"$CURL_BIN" --fail --silent --show-error --connect-timeout 1 --max-time 5 \
  "http://127.0.0.1:$BACKEND_PORT/health" -o "$backend_health"
"$NODE_BIN" - "$backend_health" <<'NODE'
const fs = require('fs');
const body = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (body.status !== 'healthy' || body.server?.status !== 'online' || body.database !== 'connected') {
  throw new Error('backend readiness payload is not healthy');
}
NODE

internal_secret="$("$NODE_BIN" - "$BASE_DIR/.env" <<'NODE'
const fs = require('fs');
for (const line of fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/u)) {
  const match = line.match(/^\s*(?:export\s+)?INTERNAL_API_SECRET\s*=\s*(.*)\s*$/u);
  if (!match) continue;
  let value = match[1].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  process.stdout.write(value);
  process.exit(0);
}
process.exit(2);
NODE
)"
[ -n "$internal_secret" ] || { echo "content-engine readiness credential is missing" >&2; exit 1; }
printf 'x-internal-secret: %s\n' "$internal_secret" > "$content_header"
unset internal_secret
"$CURL_BIN" --fail --silent --show-error --connect-timeout 1 --max-time 5 \
  -H @"$content_header" "http://127.0.0.1:$CONTENT_PORT/ready" -o "$content_ready"
"$NODE_BIN" - "$content_ready" <<'NODE'
const fs = require('fs');
const body = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (body.status !== 'ready' || body.internalAuthConfigured !== true) {
  throw new Error('authenticated content-engine readiness failed');
}
NODE

[ "$STABILITY_SECONDS" -eq 0 ] || sleep "$STABILITY_SECONDS"
snapshot_pm2 "$final"

"$NODE_BIN" - "$baseline" "$final" "$OUTPUT" "$ROLE" "$RUNTIME_SHA" "$STABILITY_SECONDS" <<'NODE'
const fs = require('fs');
const [baselinePath, finalPath, output, role, runtimeSha, stabilitySeconds] = process.argv.slice(2);
const before = JSON.parse(fs.readFileSync(baselinePath, 'utf8')).services;
const after = JSON.parse(fs.readFileSync(finalPath, 'utf8')).services;
for (const initial of before) {
  const current = after.find((service) => service.name === initial.name);
  if (!current) throw new Error(`PM2 stability sample is missing ${initial.name}`);
  if (current.pid !== initial.pid || current.restartTime !== initial.restartTime
      || current.unstableRestarts !== initial.unstableRestarts || current.uptime < initial.uptime) {
    throw new Error(`PM2 restart stability failed: ${initial.name}`);
  }
}
const evidence = {
  schema: 'nexus.release-readiness.v1',
  role,
  runtimeSha,
  checkedAt: new Date().toISOString(),
  stabilitySeconds: Number(stabilitySeconds),
  checks: {
    nativeBinding: true,
    sqliteIntegrity: true,
    sqliteForeignKeys: true,
    backendHealth: true,
    authenticatedContentEngine: true,
    pm2ExactIdentity: true,
    pm2RestartStable: true,
  },
  services: after,
};
fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
NODE

printf 'release_readiness_ok role=%s runtimeSha=%s stabilitySeconds=%s\n' "$ROLE" "$RUNTIME_SHA" "$STABILITY_SECONDS"
