#!/usr/bin/env bash
set -euo pipefail

node dist/tools/decision-center-smoke-cleanup.js "$@"
