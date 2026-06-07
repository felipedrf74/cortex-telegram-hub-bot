#!/usr/bin/env bash
# Start the local release sandbox before staging. This is a friendly release
# entrypoint around the Docker Compose local sandbox, not a production deploy.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "Release sandbox: booting local portal + content-engine + SQLite"
"$ROOT/scripts/local-up.sh"

echo ""
echo "Release sandbox is up. Run scripts/release-sandbox-smoke.sh next."
