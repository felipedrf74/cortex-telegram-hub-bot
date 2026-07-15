#!/usr/bin/env bash
# Compatibility entrypoint. The classifier is implemented in a pure Node
# module so fixture coverage does not pay repeated shell/Git process cost.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$ROOT/scripts/changed-area-classifier.mjs" "$@"
