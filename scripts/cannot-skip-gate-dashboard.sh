#!/usr/bin/env bash
# Compatibility entrypoint. Gate fixtures are classified in one Node process.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$ROOT/scripts/cannot-skip-gate-dashboard.mjs" "$@"
