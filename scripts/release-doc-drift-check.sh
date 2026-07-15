#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STRICT=false
JSON=false
for arg in "$@"; do
  case "$arg" in
    --strict) STRICT=true ;;
    --json) JSON=true ;;
    -h|--help) echo "Usage: scripts/release-doc-drift-check.sh [--strict] [--json]"; exit 0 ;;
  esac
done

if OUTPUT="$(node "$ROOT/scripts/audit-docs.mjs" --strict --json 2>&1)"; then
  [ "$JSON" = true ] && printf '%s\n' "$OUTPUT" || echo "release documentation is canonical and current"
  exit 0
fi
[ "$JSON" = true ] && printf '%s\n' "$OUTPUT" || printf '%s\n' "$OUTPUT" >&2
[ "$STRICT" = true ] && exit 1
exit 0
