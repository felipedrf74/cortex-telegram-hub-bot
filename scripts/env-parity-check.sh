#!/usr/bin/env bash
# Compare staging/prod env key presence without printing secret values.

set -euo pipefail

SERVER="${DEPLOY_SERVER:-dominguez@serverdominguez}"
STAGING_DIR="${STAGING_PATH:-/home/dominguez/telegram-hub-bot-staging}"
PROD_DIR="${DEPLOY_PATH:-/home/dominguez/telegram-hub-bot}"

while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    --staging-dir) STAGING_DIR="$2"; shift 2 ;;
    --prod-dir|--remote-dir) PROD_DIR="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,90p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 64 ;;
  esac
done

ssh "$SERVER" bash -s -- "$STAGING_DIR" "$PROD_DIR" <<'REMOTE'
set -euo pipefail

STAGING_DIR="$1"
PROD_DIR="$2"

for env_file in "$STAGING_DIR/.env" "$PROD_DIR/.env"; do
  if [ ! -f "$env_file" ]; then
    echo "missing_env:$env_file"
    exit 1
  fi
done

node - "$STAGING_DIR/.env" "$PROD_DIR/.env" <<'NODE'
const fs = require('fs');
const [stagingPath, prodPath] = process.argv.slice(2);

const optional = new Set([
  'SENTRY_DSN',
  'HEALTH_TOKEN',
  'PORTAL_REQUIRE_SESSION_AUTH',
]);

const requiredBoth = [
  'AI_CALL_TIMEOUT_MS',
  'OAUTH_ENCRYPTION_KEY',
  'INTERNAL_API_SECRET',
];

const productionRequired = [
  'NODE_ENV',
  'BACKUP_ENCRYPT',
  'INTERNAL_API_SECRET',
  'OAUTH_ENCRYPTION_KEY',
];

function parse(file) {
  const out = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    out.set(match[1], match[2]);
  }
  return out;
}

function configured(map, key) {
  return map.has(key) && String(map.get(key) ?? '').trim() !== '';
}

function normalized(map, key) {
  return String(map.get(key) ?? '').trim().replace(/^['"]|['"]$/g, '');
}

const staging = parse(stagingPath);
const prod = parse(prodPath);
const allKeys = [...new Set([...staging.keys(), ...prod.keys()])].sort();
const failures = [];

for (const key of allKeys) {
  if (optional.has(key)) continue;
  const stagingConfigured = configured(staging, key);
  const prodConfigured = configured(prod, key);
  if (stagingConfigured !== prodConfigured) {
    failures.push(`${key}:staging=${stagingConfigured ? 'set' : 'missing'}:prod=${prodConfigured ? 'set' : 'missing'}`);
  }
}

for (const key of requiredBoth) {
  if (!configured(staging, key) || !configured(prod, key)) {
    failures.push(`${key}:required_shared_key_missing`);
  }
}

for (const key of productionRequired) {
  if (!configured(prod, key)) {
    failures.push(`${key}:prod_required_missing`);
  }
}

if (normalized(prod, 'NODE_ENV') !== 'production') {
  failures.push(`NODE_ENV:prod_expected_production:actual=${normalized(prod, 'NODE_ENV') || 'missing'}`);
}

if (!new Set(['1', 'true', 'yes']).has(normalized(prod, 'BACKUP_ENCRYPT').toLowerCase())) {
  failures.push(`BACKUP_ENCRYPT:prod_expected_enabled:actual=${normalized(prod, 'BACKUP_ENCRYPT') || 'missing'}`);
}

if (failures.length) {
  console.error('env_parity_failed');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`env_parity_ok sharedKeys=${allKeys.length}`);
NODE
REMOTE
