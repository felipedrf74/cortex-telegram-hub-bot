#!/usr/bin/env bash
# Exercise the Notification/Decision release-gate invariants against scoped fixtures.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

npx vitest run __tests__/scripts/notification-release-gate.test.ts
