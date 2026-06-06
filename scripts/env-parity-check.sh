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
      sed -n '2,80p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 64 ;;
  esac
done

ssh "$SERVER" "set -euo pipefail
  STAGING_DIR='$STAGING_DIR'
  PROD_DIR='$PROD_DIR'
  for env_file in \"\$STAGING_DIR/.env\" \"\$PROD_DIR/.env\"; do
    if [ ! -f \"\$env_file\" ]; then
      echo \"missing_env:\$env_file\"
      exit 1
    fi
  done
  node - <<'NODE' \"\$STAGING_DIR/.env\" \"\$PROD_DIR/.env\"
const fs = require('fs');
const [stagingPath, prodPath] = process.argv.slice(2);

const allowDifferent = new Set([
  'NODE_ENV',
  'ENV',
  'STAGING',
  'PORTAL_PORT',
  'CONTENT_ENGINE_PORT',
  'NEXUS_BACKEND_BASE_URL',
  'NEXUS_BACKEND_PORT',
  'DATABASE_PATH',
  'PORTAL_TOKEN',
  'PORTAL_ADMIN_TOKEN',
  'PORTAL_READ_TOKEN',
  'PORTAL_WRITE_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'OWNER_TELEGRAM_ID',
  'TELEGRAM_ALLOWED_USER_IDS',
  'SENTRY_ENVIRONMENT',
]);

const optional = new Set([
  'SENTRY_DSN',
  'HEALTH_TOKEN',
  'PORTAL_REQUIRE_SESSION_AUTH',
]);

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

function secretLike(key) {
  return /(SECRET|TOKEN|PASSWORD|PASS|PRIVATE|KEY|DSN|WEBHOOK|CLIENT_SECRET|ENCRYPTION|JWT|COOKIE|AUTH)/i.test(key);
}

const staging = parse(stagingPath);
const prod = parse(prodPath);
const allKeys = [...new Set([...staging.keys(), ...prod.keys()])].sort();
const failures = [];

for (const key of allKeys) {
  if (allowDifferent.has(key) || optional.has(key)) continue;
  const stagingConfigured = configured(staging, key);
  const prodConfigured = configured(prod, key);
  if (stagingConfigured !== prodConfigured) {
    failures.push(`${key}:staging=${stagingConfigured ? 'set' : 'missing'}:prod=${prodConfigured ? 'set' : 'missing'}`);
    continue;
  }
  if (stagingConfigured && prodConfigured && !secretLike(key)) {
    const stagingValue = String(staging.get(key) ?? '').trim();
    const prodValue = String(prod.get(key) ?? '').trim();
    if (stagingValue !== prodValue) {
      failures.push(`${key}:value_diff`);
    }
  }
}

for (const key of ['AI_CALL_TIMEOUT_MS', 'OAUTH_ENCRYPTION_KEY', 'INTERNAL_API_SECRET']) {
  if (!configured(staging, key) || !configured(prod, key)) {
    failures.push(`${key}:required_shared_key_missing`);
  }
}

if (failures.length) {
  console.error('env_parity_failed');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`env_parity_ok sharedKeys=${allKeys.length}`);
NODE
"
