#!/usr/bin/env bash
# Recreate selected PM2 processes from a minimal client environment, then
# persist a secret-free resurrection dump. Runtime applications load secrets
# directly from their protected .env files; PM2 must never retain those values.

set -euo pipefail
umask 077

REMOTE_DIR="${1:?remote directory is required}"
PM2="${2:?PM2 executable is required}"
GIT_COMMIT="${3:?Git commit is required}"
ECOSYSTEM_FILE="${4:?ecosystem filename is required}"
APP_CSV="${5:?comma-separated PM2 app names are required}"
ALLOWED_ENV_CSV="${6:?comma-separated allowed app environment names are required}"

case "$REMOTE_DIR" in
  /*) ;;
  *) echo "remote directory must be absolute" >&2; exit 2 ;;
esac

case "$ECOSYSTEM_FILE" in
  */*|..|.*) echo "ecosystem filename must be a basename" >&2; exit 2 ;;
esac

if [ ! -d "$REMOTE_DIR" ] || [ ! -f "$REMOTE_DIR/$ECOSYSTEM_FILE" ]; then
  echo "remote directory or ecosystem file is missing" >&2
  exit 2
fi
if [ ! -x "$PM2" ]; then
  echo "PM2 executable is missing" >&2
  exit 2
fi
if [ -x /usr/bin/node ]; then
  NODE_BIN=/usr/bin/node
else
  NODE_BIN="$(command -v node || true)"
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "Node executable is missing" >&2
  exit 2
fi
if ! [[ "$GIT_COMMIT" =~ ^[0-9a-f]{7,64}$ ]] && [ "$GIT_COMMIT" != "rollback-unknown" ]; then
  echo "release identity must be a hexadecimal revision or rollback-unknown" >&2
  exit 2
fi

IFS=',' read -r -a APP_NAMES <<< "$APP_CSV"
if [ "${#APP_NAMES[@]}" -eq 0 ]; then
  echo "at least one PM2 app is required" >&2
  exit 2
fi
for app in "${APP_NAMES[@]}"; do
  if ! [[ "$app" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]]; then
    echo "invalid PM2 app name" >&2
    exit 2
  fi
done

SAFE_PATH="/usr/local/bin:/usr/bin:/bin:$(dirname "$PM2")"
PM2_HOME="$HOME/.pm2"
SAFE_PM2_ENV=(
  env -i
  "HOME=$HOME"
  "USER=$(id -un)"
  "LOGNAME=$(id -un)"
  "PATH=$SAFE_PATH"
  "PM2_HOME=$PM2_HOME"
  "GIT_COMMIT=$GIT_COMMIT"
)
STARTED=0
COMPLETED=0

cleanup_failed_bootstrap() {
  local status=$?
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "$STARTED" -eq 1 ] && [ "$COMPLETED" -ne 1 ]; then
    "${SAFE_PM2_ENV[@]}" "$PM2" delete "${APP_NAMES[@]}" >/dev/null 2>&1 || true
    rm -f "$PM2_HOME/dump.pm2" "$PM2_HOME/dump.pm2.bak"
  fi
  exit "$status"
}
trap cleanup_failed_bootstrap EXIT

install -d -m 700 "$PM2_HOME"
cd "$REMOTE_DIR"

# PM2 module configuration is keyed by module/app name. PM2 6.0.x treats a
# stale string-valued entry for a normal application as additional process
# environment and Object.assign() spreads it into numeric keys ("0", "1",
# ...). Remove only entries for the apps we are about to recreate; keep the
# strict named environment allowlist below rather than accepting those opaque
# synthetic values.
"$NODE_BIN" - "$PM2_HOME/module_conf.json" "$APP_CSV" <<'NODE'
const fs = require('fs');
const path = require('path');

const filename = process.argv[2];
const appNames = new Set(process.argv[3].split(',').filter(Boolean));
if (!fs.existsSync(filename)) process.exit(0);

const stat = fs.lstatSync(filename);
if (!stat.isFile() || stat.isSymbolicLink()) {
  throw new Error('PM2 module configuration is not a regular file');
}
const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
  throw new Error('PM2 module configuration must be a JSON object');
}

let changed = false;
for (const appName of appNames) {
  if (Object.prototype.hasOwnProperty.call(parsed, appName)) {
    delete parsed[appName];
    changed = true;
  }
}
if (!changed) process.exit(0);

const temporary = `${filename}.sanitizing-${process.pid}`;
const descriptor = fs.openSync(temporary, 'wx', 0o600);
try {
  fs.writeFileSync(descriptor, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  fs.fsyncSync(descriptor);
} finally {
  fs.closeSync(descriptor);
}
fs.renameSync(temporary, filename);
fs.chmodSync(filename, 0o600);
const directory = fs.openSync(path.dirname(filename), 'r');
try {
  fs.fsyncSync(directory);
} finally {
  fs.closeSync(directory);
}
NODE

# Delete rather than restart: restart/start-by-name preserves the old PM2
# process environment, including secrets inherited by a historical shell.
"${SAFE_PM2_ENV[@]}" "$PM2" delete "${APP_NAMES[@]}" >/dev/null 2>&1 || true
STARTED=1
"${SAFE_PM2_ENV[@]}" "$PM2" start "$REMOTE_DIR/$ECOSYSTEM_FILE" --only "$APP_CSV"

JLIST="$("${SAFE_PM2_ENV[@]}" "$PM2" jlist)"
printf '%s' "$JLIST" | "$NODE_BIN" -e '
  const expected = new Set(process.argv[1].split(","));
  const allowed = new Set([
    "HOME", "USER", "LOGNAME", "PATH", "PWD", "PM2_HOME",
    "PM2_JSON_PROCESSING", "PM2_USAGE", "NODE_APP_INSTANCE", "unique_id",
    ...expected,
    ...process.argv[2].split(",").filter(Boolean),
  ]);
  const deny = /(^|_)(SECRET|TOKEN|PASSWORD|PASSCODE|API_KEY|PRIVATE_KEY|ENCRYPTION_KEY|SIGNING_KEY|JWT_KEYS|AUTH_KEY_P8|CREDENTIALS?|KEYS?|CODES?|SALT|COOKIE)(_|$)/i;
  const explicit = new Set(["SENTRY_DSN", "DATABASE_URL", "REDIS_URL"]);
  let raw = "";
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", () => {
    const processes = JSON.parse(raw);
    const selected = processes.filter((item) => expected.has(item.name));
    if (selected.length !== expected.size) throw new Error("not every requested PM2 process was created");
    for (const item of selected) {
      if (item.pm2_env?.status !== "online") throw new Error("PM2 process is not online: " + item.name);
      const appEnvironment = item.pm2_env?.env || {};
      for (const key of Object.keys(appEnvironment)) {
        if (!allowed.has(key)) {
          throw new Error("PM2 process retained an environment key outside the explicit allowlist: " + item.name);
        }
      }
      const stack = [item.pm2_env || {}];
      while (stack.length > 0) {
        const value = stack.pop();
        if (!value || typeof value !== "object") continue;
        for (const [key, nested] of Object.entries(value)) {
          if (!allowed.has(key) && (deny.test(key) || explicit.has(key.toUpperCase()))) {
            throw new Error("PM2 process retained a prohibited environment key: " + item.name);
          }
          if (nested && typeof nested === "object") stack.push(nested);
        }
      }
    }
  });
' "$APP_CSV" "$ALLOWED_ENV_CSV"

"${SAFE_PM2_ENV[@]}" "$PM2" save --force

# PM2 keeps both current and backup resurrection dumps. Remove prohibited
# environment keys from every process entry, write atomically, and verify.
"$NODE_BIN" - "$PM2_HOME/dump.pm2" "$PM2_HOME/dump.pm2.bak" <<'NODE'
const fs = require('fs');
const path = require('path');

const deny = /(^|_)(SECRET|TOKEN|PASSWORD|PASSCODE|API_KEY|PRIVATE_KEY|ENCRYPTION_KEY|SIGNING_KEY|JWT_KEYS|AUTH_KEY_P8|CREDENTIALS?|KEYS?|CODES?|SALT|COOKIE)(_|$)/i;
const explicit = new Set(['SENTRY_DSN', 'DATABASE_URL', 'REDIS_URL']);

function scrub(value) {
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (deny.test(key) || explicit.has(key.toUpperCase())) {
      delete value[key];
      continue;
    }
    scrub(value[key]);
  }
}

function assertClean(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (deny.test(key) || explicit.has(key.toUpperCase())) {
      throw new Error('PM2 resurrection dump retained prohibited key: ' + key);
    }
    assertClean(nested);
  }
}

for (const filename of process.argv.slice(2)) {
  if (!fs.existsSync(filename)) continue;
  const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
  scrub(parsed);
  assertClean(parsed);
  const temporary = filename + '.sanitizing-' + process.pid;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, filename);
  fs.chmodSync(filename, 0o600);
  const directory = fs.openSync(path.dirname(filename), 'r');
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}
NODE

chmod 700 "$PM2_HOME"
find "$PM2_HOME" -maxdepth 1 -type f \( -name 'dump.pm2' -o -name 'dump.pm2.bak' \) -exec chmod 600 {} +
COMPLETED=1
echo "PM2 processes recreated with a minimal environment; resurrection dumps sanitized."
