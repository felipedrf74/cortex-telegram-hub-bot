#!/usr/bin/env bash
# Readiness checks for an already-started staging/prod install. This is a
# deploy gate, not a release trigger: it only reads remote state.

set -euo pipefail

TARGET="prod"
SERVER="${DEPLOY_SERVER:-dominguez@serverdominguez}"
REMOTE_DIR=""
PORTAL_PORT=""
CONTENT_PORT=""
PM2_APP=""
PM2_CONTENT_APP=""
MIN_UPTIME_MS="${NEXUS_DEPLOY_MIN_UPTIME_MS:-10000}"
MAX_PM2_RESTARTS="${NEXUS_DEPLOY_MAX_PM2_RESTARTS:-1000}"

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --server) SERVER="$2"; shift 2 ;;
    --remote-dir) REMOTE_DIR="$2"; shift 2 ;;
    --portal-port) PORTAL_PORT="$2"; shift 2 ;;
    --content-port) CONTENT_PORT="$2"; shift 2 ;;
    --pm2-app) PM2_APP="$2"; shift 2 ;;
    --pm2-content-app) PM2_CONTENT_APP="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,80p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 64 ;;
  esac
done

case "$TARGET" in
  prod|production)
    REMOTE_DIR="${REMOTE_DIR:-/home/dominguez/telegram-hub-bot}"
    PORTAL_PORT="${PORTAL_PORT:-8200}"
    CONTENT_PORT="${CONTENT_PORT:-8100}"
    PM2_APP="${PM2_APP:-nexus-hub}"
    PM2_CONTENT_APP="${PM2_CONTENT_APP:-content-engine}"
    ;;
  staging)
    REMOTE_DIR="${REMOTE_DIR:-/home/dominguez/telegram-hub-bot-staging}"
    PORTAL_PORT="${PORTAL_PORT:-8201}"
    CONTENT_PORT="${CONTENT_PORT:-8101}"
    PM2_APP="${PM2_APP:-nexus-hub-staging}"
    PM2_CONTENT_APP="${PM2_CONTENT_APP:-content-engine-staging}"
    ;;
  *) echo "Unknown target: $TARGET" >&2; exit 64 ;;
esac

ssh "$SERVER" "set -euo pipefail
  REMOTE_DIR='$REMOTE_DIR'
  PORTAL_PORT='$PORTAL_PORT'
  CONTENT_PORT='$CONTENT_PORT'
  PM2_APP='$PM2_APP'
  PM2_CONTENT_APP='$PM2_CONTENT_APP'
  PM2='/home/dominguez/.npm-global/bin/pm2'
  MIN_UPTIME_MS='$MIN_UPTIME_MS'
  MAX_PM2_RESTARTS='$MAX_PM2_RESTARTS'
  export PM2_APP PM2_CONTENT_APP MIN_UPTIME_MS MAX_PM2_RESTARTS

  cd \"\$REMOTE_DIR\"
  echo '   Checking .env mode...'
  if [ ! -f .env ]; then
    echo '   ❌ .env missing'
    exit 1
  fi
  MODE=\$(stat -c '%a' .env 2>/dev/null || stat -f '%Lp' .env 2>/dev/null || echo unknown)
  case \"\$MODE\" in
    400|600) echo \"   ✅ .env mode \$MODE\" ;;
    *) echo \"   ❌ .env mode \$MODE is unsafe; require 400 or 600\"; exit 1 ;;
  esac
  OWNER=\$(stat -c '%U' .env 2>/dev/null || stat -f '%Su' .env 2>/dev/null || echo unknown)
  CURRENT_OWNER=\$(id -un)
  if [ \"\$OWNER\" != \"\$CURRENT_OWNER\" ]; then
    echo \"   ❌ .env owner \$OWNER is unsafe; expected \$CURRENT_OWNER\"
    exit 1
  fi
  echo \"   ✅ .env owner \$OWNER\"

  echo '   Checking SQLite integrity...'
  DB_PATH=\$(grep -oE '^DATABASE_PATH=.+' .env 2>/dev/null | tail -1 | cut -d= -f2- || true)
  DB_PATH=\${DB_PATH:-\$REMOTE_DIR/data/bot.db}
  if [ ! -f \"\$DB_PATH\" ]; then
    echo \"   ❌ DB missing at \$DB_PATH\"
    exit 1
  fi
  if command -v sqlite3 >/dev/null 2>&1; then
    DB_RESULT=\$(sqlite3 \"\$DB_PATH\" 'PRAGMA integrity_check;' 2>/dev/null || true)
  else
    DB_RESULT=\$(/usr/bin/node - <<'NODE' \"\$DB_PATH\" 2>/dev/null || true
const dbPath = process.argv[2];
const Database = require('better-sqlite3');
const db = new Database(dbPath, { readonly: true });
try {
  const row = db.pragma('integrity_check')[0];
  process.stdout.write(String(row.integrity_check || row[Object.keys(row)[0]] || ''));
} finally {
  db.close();
}
NODE
)
  fi
  if [ \"\$DB_RESULT\" != 'ok' ]; then
    echo \"   ❌ SQLite integrity_check failed: \$DB_RESULT\"
    exit 1
  fi
  echo '   ✅ SQLite integrity_check ok'

  echo '   Checking native better-sqlite3 binding under /usr/bin/node...'
  /usr/bin/node -e \"require('better-sqlite3'); console.log('   ✅ better-sqlite3 loads')\"

  echo '   Checking TypeScript /health readiness...'
  HEALTH=\$(curl -fsS \"http://127.0.0.1:\$PORTAL_PORT/health\")
  printf '%s' \"\$HEALTH\" | /usr/bin/node -e \"
    let body = '';
    process.stdin.on('data', c => body += c);
    process.stdin.on('end', () => {
      const j = JSON.parse(body);
      if (j.status !== 'healthy') throw new Error('health_status_' + j.status);
      if (j.server?.database !== 'connected' && j.database !== 'connected') throw new Error('database_not_connected');
      console.log('   ✅ portal /health healthy');
    });
  \"

  echo '   Checking content-engine readiness...'
  CONTENT_SECRET=\$(grep -oE '^INTERNAL_API_SECRET=.+' .env 2>/dev/null | tail -1 | cut -d= -f2- || true)
  if [ -n \"\$CONTENT_SECRET\" ]; then
    CONTENT_READY=\$(curl -fsS -H \"x-internal-secret: \$CONTENT_SECRET\" \"http://127.0.0.1:\$CONTENT_PORT/ready\")
  else
    CONTENT_READY=\$(curl -fsS \"http://127.0.0.1:\$CONTENT_PORT/health\")
  fi
  printf '%s' \"\$CONTENT_READY\" | /usr/bin/node -e \"
    let body = '';
    process.stdin.on('data', c => body += c);
    process.stdin.on('end', () => {
      const j = JSON.parse(body);
      if (!['ready', 'ok'].includes(j.status)) throw new Error('content_status_' + j.status);
      if (j.status === 'ready' && j.internalAuthConfigured !== true) throw new Error('content_internal_auth_not_configured');
      console.log('   ✅ content-engine ready');
    });
  \"

  echo '   Checking PM2 status and uptime...'
  export PATH=\$PATH:\$(dirname \"\$PM2\")
  \$PM2 jlist 2>/dev/null | /usr/bin/node -e \"
    let body = '';
    process.stdin.on('data', c => body += c);
    process.stdin.on('end', () => {
      const apps = JSON.parse(body);
      const names = [process.env.PM2_APP, process.env.PM2_CONTENT_APP].filter(Boolean);
      const minUptime = Number(process.env.MIN_UPTIME_MS || 0);
      for (const name of names) {
        const app = apps.find(p => p.name === name);
        if (!app) throw new Error('pm2_missing_' + name);
        if (app.pm2_env?.status !== 'online') throw new Error('pm2_not_online_' + name + ':' + app.pm2_env?.status);
        const uptimeMs = Date.now() - Number(app.pm2_env?.pm_uptime || Date.now());
        const restarts = Number(app.pm2_env?.restart_time || 0);
        if (uptimeMs < minUptime) throw new Error('pm2_uptime_too_low_' + name + ':' + uptimeMs);
        if (restarts > Number(process.env.MAX_PM2_RESTARTS || 1000)) throw new Error('pm2_restarts_high_' + name + ':' + restarts);
      }
      console.log('   ✅ PM2 apps online and stable');
    });
  \"
"
