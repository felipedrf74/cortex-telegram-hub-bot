#!/usr/bin/env bash
# Exercise release deploy/promote dry-run behavior with fake command stubs.
# This harness does not SSH, rsync, stop PM2, or touch staging/prod.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

npx vitest run \
  __tests__/scripts/release-deploy-dry-runs.test.ts \
  __tests__/scripts/deploy-shell-hardening.test.ts
