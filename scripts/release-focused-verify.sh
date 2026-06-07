#!/usr/bin/env bash
# Risk-based local release verification for minor/pre-RC changes.
# Full Vitest remains available through scripts/release-verify.sh and CI RC
# evidence; this runner avoids re-running the 10k+ suite for low-risk diffs.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BASE_REF="${NEXUS_RELEASE_FOCUSED_BASE_REF:-origin/main}"
EXPLICIT_FILES=""
DRY_RUN=false
FORCE_FULL=false

usage() {
  cat <<'EOF'
Usage:
  scripts/release-focused-verify.sh [--base <ref>] [--files <comma-list>] [--full] [--dry-run]

Runs docs-only checks for docs-only diffs, otherwise delegates to the
changed-area risk gate for focused Vitest/pytest selection. Use --full when
you intentionally want the local full suite before CI RC evidence exists.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE_REF="$2"; shift 2 ;;
    --files) EXPLICIT_FILES="$2"; shift 2 ;;
    --full) FORCE_FULL=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage >&2; exit 64 ;;
  esac
done

run_cmd() {
  printf '▶ %s\n' "$*"
  if [ "$DRY_RUN" != "true" ]; then
    "$@"
  fi
}

json_get() {
  local expr="$1"
  node -e '
    const fs = require("fs");
    const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const expr = process.argv[2].split(".");
    let value = data;
    for (const part of expr) value = value?.[part];
    if (Array.isArray(value)) process.stdout.write(value.join("\n"));
    else if (value === null || value === undefined) process.stdout.write("");
    else process.stdout.write(String(value));
  ' "$CLASSIFIER_JSON_FILE" "$expr"
}

CLASSIFIER_JSON_FILE="$(mktemp)"
trap 'rm -f "$CLASSIFIER_JSON_FILE"' EXIT

classifier_args=(--format json --base "$BASE_REF")
if [ -n "$EXPLICIT_FILES" ]; then
  classifier_args+=(--files "$EXPLICIT_FILES")
fi

if ! scripts/changed-area-classifier.sh "${classifier_args[@]}" > "$CLASSIFIER_JSON_FILE"; then
  echo "⚠️  classifier failed — escalating to full local release verify" >&2
  if [ "$DRY_RUN" = "true" ]; then
    printf '▶ scripts/release-verify.sh\n'
    exit 0
  fi
  exec scripts/release-verify.sh
fi

VITEST_MODE="$(json_get "vitest.mode")"
SKIP_REASON="$(json_get "vitest.skipReason")"
CANNOT_SKIP="$(json_get "cannotSkip")"

echo "═══════════════════════════════════════════════"
echo "  Nexus focused release verify"
echo "═══════════════════════════════════════════════"
echo "base: $BASE_REF"
echo "vitest mode: $VITEST_MODE"
if [ -n "$CANNOT_SKIP" ]; then
  echo "cannot-skip gates:"
  printf '  - %s\n' $CANNOT_SKIP
fi

if [ "$FORCE_FULL" = "true" ] || [ "$VITEST_MODE" = "full" ]; then
  run_cmd scripts/release-verify.sh
  exit 0
fi

if [ "$VITEST_MODE" = "skip" ] && [[ "$SKIP_REASON" == docs-only* ]]; then
  echo "🧾 Docs-only release diff: skipping Vitest and running docs checks."
  run_cmd ./scripts/release-doc-drift-check.sh --strict
  run_cmd npm run docs:audit
  echo "✅ focused release verify complete"
  exit 0
fi

run_cmd npm run science-policy:check
risk_args=(--base "$BASE_REF")
if [ -n "$EXPLICIT_FILES" ]; then
  risk_args+=(--files "$EXPLICIT_FILES")
fi
run_cmd env NEXUS_RISK_GATE_ASSERT_CANNOT_SKIP_DASHBOARD=1 scripts/risk-gate.sh "${risk_args[@]}"
run_cmd ./scripts/release-doc-drift-check.sh --strict

echo "✅ focused release verify complete"
