#!/usr/bin/env bash
# Run local release-sandbox readiness checks. This mirrors the deploy-readiness
# shape locally: portal health, content readiness, SQLite integrity, native
# better-sqlite3 load, and a basic env-shape guard.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -f .env.local ]; then
  # shellcheck disable=SC1091
  set -a; source .env.local; set +a
fi

CONTENT_PORT="${NEXUS_LOCAL_PORT_PY:-8100}"

echo "Release sandbox: running local smoke contract"
"$ROOT/scripts/local-smoke.sh" "$@"

echo ""
echo "Release sandbox: checking content-engine readiness"
CONTENT_AUTH_HEADERS=()
if [ -n "${INTERNAL_API_SECRET:-}" ]; then
  CONTENT_AUTH_HEADERS=(-H "x-internal-secret: ${INTERNAL_API_SECRET}")
fi
CONTENT_BODY="$(curl -fsS "${CONTENT_AUTH_HEADERS[@]}" "http://127.0.0.1:${CONTENT_PORT}/ready" 2>/dev/null || curl -fsS "http://127.0.0.1:${CONTENT_PORT}/health")"
printf '%s' "$CONTENT_BODY" | node -e "
let body = '';
process.stdin.on('data', c => body += c);
process.stdin.on('end', () => {
  const j = JSON.parse(body);
  if (!['ready', 'ok'].includes(j.status)) throw new Error('content_status_' + j.status);
  console.log('  ok content-engine readiness');
});
"

echo "Release sandbox: checking native better-sqlite3 inside compose"
docker compose -f docker-compose.local.yml exec -T nexus-hub node -e "require('better-sqlite3'); console.log('  ok better-sqlite3 loads')"

echo "Release sandbox: checking local env shape"
if [ -f .env.local ]; then
  if grep -qE '^NODE_ENV=production$' .env.local; then
    echo "  error .env.local must not set NODE_ENV=production" >&2
    exit 1
  fi
  echo "  ok .env.local is non-production"
else
  echo "  ok .env.local absent; compose uses safe local defaults"
fi

echo ""
echo "Release sandbox smoke passed"
