#!/usr/bin/env bash
# Exercise exact-release preflight, readiness, and recovery behavior with fakes.
# This harness does not SSH, rsync, stop PM2, or touch staging/prod.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

npx vitest run \
  __tests__/scripts/release-runtime-safeguards.test.ts \
  __tests__/scripts/exact-promotion-operational-safety.test.ts
