#!/usr/bin/env bash
# Compare staging/prod env shape without printing secret values.

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

validate_remote_dir_arg() {
  local label="$1"
  local value="$2"
  if ! [[ "$value" =~ ^[A-Za-z0-9_./-]+$ ]]; then
    echo "Invalid $label: only A-Z a-z 0-9 _ . / - are allowed" >&2
    exit 2
  fi
}

validate_remote_dir_arg STAGING_DIR "$STAGING_DIR"
validate_remote_dir_arg PROD_DIR "$PROD_DIR"

ssh "$SERVER" bash -s -- "$STAGING_DIR" "$PROD_DIR" <<'REMOTE'
set -euo pipefail

STAGING_DIR="$1"
PROD_DIR="$2"

for env_file in "$STAGING_DIR/.env" "$PROD_DIR/.env"; do
  if [ ! -f "$env_file" ] || [ -L "$env_file" ]; then
    echo "missing_env:$env_file"
    exit 1
  fi
  mode="$(stat -c '%a' "$env_file" 2>/dev/null || stat -f '%Lp' "$env_file" 2>/dev/null || true)"
  case "$mode" in 400|600) ;; *) echo "unsafe_env_mode:$env_file"; exit 1 ;; esac
  owner="$(stat -c '%U' "$env_file" 2>/dev/null || stat -f '%Su' "$env_file" 2>/dev/null || true)"
  [ "$owner" = "$(id -un)" ] || { echo "unsafe_env_owner:$env_file"; exit 1; }
done

node - "$STAGING_DIR/.env" "$PROD_DIR/.env" <<'NODE'
const fs = require('fs');
const [stagingPath, prodPath] = process.argv.slice(2);
const path = require('path');

const optional = new Set([
  // These domain keys are intentionally optional because each environment
  // may either use a dedicated key or the OAUTH_ENCRYPTION_KEY fallback.
  // Presence parity would otherwise encourage unsafe cross-environment key
  // copying. Effective-key checks below still fail closed without either.
  'GARMIN_ENCRYPTION_KEY',
  'HEALTH_DATA_ENCRYPTION_KEY',
  'SENTRY_DSN',
  'HEALTH_TOKEN',
  'PORTAL_REQUIRE_SESSION_AUTH',
]);

const prodOnly = [
  /^AI_CLASSIFY_/,
  /^APNS_/,
  /^BACKUP_/,
  /^CLASSIFY_SHADOW_/,
  /^FINANCE_/,
  /^LOCAL_LLM_/,
  /^OLLAMA_CLASSIFIER_/,
  /^OLLAMA_CLASSIFY_/,
  /^STRIPE_PRICE_.*YEARLY/,
  /^TELEGRAM_/,
  'IOS_OWNER_CODE',
  'NOTIFICATION_DELIVERY_MODE',
  'PAYWALL_ENABLED',
];

const stagingOnly = [
  /^EVENT_BACKBONE_/,
  /^OPERATOR_ALERT_/,
  /^PORTAL_ADMIN_/,
  /^PORTAL_OPERATOR_/,
  /^PORTAL_SESSION_/,
  /^STRIPE_PRICE_ID_POINTS_/,
  'PORTAL_BETA_HARDENED',
  'PORTAL_PORT',
  'STAGING',
  'STRIPE_NEXUS_POINTS_ENABLED',
];

const requiredBoth = [
  'AI_CALL_TIMEOUT_MS',
  'OAUTH_ENCRYPTION_KEY',
  'INTERNAL_API_SECRET',
];

const productionRequired = [
  'BACKUP_ENCRYPT',
  'BACKUP_KEY',
  'INTERNAL_API_SECRET',
  'OAUTH_ENCRYPTION_KEY',
];

const stagingRequired = [
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

function hasEffectiveEncryptionKey(map, dedicatedKey) {
  return normalized(map, dedicatedKey).trim() !== ''
    || normalized(map, 'OAUTH_ENCRYPTION_KEY').trim() !== '';
}

function matchesRule(key, rules) {
  return rules.some((rule) => {
    if (rule instanceof RegExp) return rule.test(key);
    return rule === key;
  });
}

function readEffectiveNodeEnv(envPath, target, envMap) {
  const fromEnv = normalized(envMap, 'NODE_ENV');
  if (fromEnv) return { value: fromEnv, source: '.env' };

  const dir = path.dirname(envPath);
  let currentDir = '';
  try {
    const current = path.join(dir, 'current');
    if (fs.lstatSync(current).isSymbolicLink()) currentDir = fs.realpathSync(current);
  } catch {
    currentDir = '';
  }
  const ecosystemCandidates = target === 'staging'
    ? [
      ...(currentDir ? [path.join(currentDir, 'ecosystem.release.config.js')] : []),
      path.join(dir, 'ecosystem.staging.config.js'),
      path.join(dir, 'ecosystem.config.js'),
    ]
    : [
      ...(currentDir ? [path.join(currentDir, 'ecosystem.release.config.js')] : []),
      path.join(dir, 'ecosystem.config.js'),
    ];
  for (const candidate of ecosystemCandidates) {
    const fullPath = path.resolve(candidate);
    if (!fs.existsSync(fullPath)) continue;
    const body = fs.readFileSync(fullPath, 'utf8');
    const match = body.match(/NODE_ENV\s*:\s*['"]([^'"]+)['"]/);
    if (match) return { value: match[1], source: candidate };
  }
  return { value: '', source: 'missing' };
}

const staging = parse(stagingPath);
const prod = parse(prodPath);
const allKeys = [...new Set([...staging.keys(), ...prod.keys()])].sort();
const failures = [];

for (const key of allKeys) {
  if (optional.has(key)) continue;
  if (key === 'NODE_ENV') continue;
  const stagingConfigured = configured(staging, key);
  const prodConfigured = configured(prod, key);
  if (stagingConfigured !== prodConfigured) {
    if (!stagingConfigured && prodConfigured && matchesRule(key, prodOnly)) continue;
    if (stagingConfigured && !prodConfigured && matchesRule(key, stagingOnly)) continue;
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

for (const key of stagingRequired) {
  if (!configured(staging, key)) {
    failures.push(`${key}:staging_required_missing`);
  }
}

for (const dedicatedKey of ['GARMIN_ENCRYPTION_KEY', 'HEALTH_DATA_ENCRYPTION_KEY']) {
  if (!hasEffectiveEncryptionKey(staging, dedicatedKey)) {
    failures.push(`${dedicatedKey}:staging_effective_key_missing`);
  }
  if (!hasEffectiveEncryptionKey(prod, dedicatedKey)) {
    failures.push(`${dedicatedKey}:prod_effective_key_missing`);
  }
}

const prodNodeEnv = readEffectiveNodeEnv(prodPath, 'prod', prod);
const stagingNodeEnv = readEffectiveNodeEnv(stagingPath, 'staging', staging);
if (prodNodeEnv.value !== 'production') {
  failures.push(`NODE_ENV:prod_expected_production:actual=${prodNodeEnv.value || 'missing'}:source=${prodNodeEnv.source}`);
}
if (stagingNodeEnv.value !== 'staging') {
  failures.push(`NODE_ENV:staging_expected_staging:actual=${stagingNodeEnv.value || 'missing'}:source=${stagingNodeEnv.source}`);
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
