#!/usr/bin/env bash
# Start the local release sandbox before staging. This is a friendly release
# entrypoint around the Docker Compose local sandbox, not a production deploy.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "Release sandbox: booting local portal + content-engine + SQLite"
echo "Release sandbox: refreshing Node dependency volume"
docker compose -f docker-compose.local.yml down
docker volume rm nexus_hub_local_node_modules >/dev/null 2>&1 || true
"$ROOT/scripts/local-up.sh"

echo ""
echo "Release sandbox is up. Run scripts/release-sandbox-smoke.sh next."
