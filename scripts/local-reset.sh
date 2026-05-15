#!/usr/bin/env bash
# local-reset.sh — full wipe: stop containers, drop the local DB, drop
# named volumes (node_modules cache + content-engine .venv). Next
# `./scripts/local-up.sh` rebuilds from scratch.
#
# Refuses to run if .env.local doesn't exist (means the sandbox was
# never set up; nothing to reset). Prompts before destructive action
# unless --yes is passed.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

AUTO_YES="${LOCAL_RESET_YES:-0}"
if [ "${1:-}" = "--yes" ] || [ "${1:-}" = "-y" ]; then
  AUTO_YES=1
fi

if [ ! -f .env.local ]; then
  echo "No .env.local found — nothing to reset."
  exit 0
fi

echo "This will:"
echo "  - stop the sandbox containers"
echo "  - drop named volumes (node_modules cache + content-engine .venv)"
echo "  - delete ./data/local.db (and -shm / -wal sidecars)"
echo ""

if [ "$AUTO_YES" != "1" ]; then
  printf "Proceed? [y/N] "
  read -r reply
  case "$reply" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 0 ;;
  esac
fi

docker compose -f docker-compose.local.yml down -v

rm -f \
  "$ROOT/data/local.db" \
  "$ROOT/data/local.db-shm" \
  "$ROOT/data/local.db-wal"

echo "Reset complete. Run ./scripts/local-up.sh to rebuild."
