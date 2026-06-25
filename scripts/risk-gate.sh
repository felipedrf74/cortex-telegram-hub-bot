#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/lib/release-gates.sh"
cd "$ROOT"

BASE_REF=""
EXPLICIT_FILES=""
DRY_RUN=false
FORCE_FULL=false
SKIP_TYPECHECK=false
SKIP_PYTHON=false
SKIP_MIGRATIONS=false
REPORTER="${NEXUS_RISK_GATE_REPORTER:-dot}"

usage() {
  cat <<'EOF'
Usage:
  scripts/risk-gate.sh [--base <ref>] [--files <comma-list>] [--dry-run]

Options:
  --base <ref>        Base ref for classifier + vitest --changed.
  --files <list>      Comma-separated file list for hook callers.
  --full              Force full Vitest regardless of classifier output.
  --skip-typecheck    Skip tsc; useful when CI has a separate typecheck job.
  --skip-python       Skip pytest execution even if content-engine changed.
  --skip-migrations   Skip changed-migration policy even if migrations changed.
  --dry-run           Print the selected commands without executing them.

Env:
  NEXUS_FORCE_FULL_GATE=1       Force full Vitest.
  NEXUS_RISK_GATE_REPORTER=dot  Vitest reporter.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE_REF="$2"; shift 2 ;;
    --files) EXPLICIT_FILES="$2"; shift 2 ;;
    --full) FORCE_FULL=true; shift ;;
    --skip-typecheck) SKIP_TYPECHECK=true; shift ;;
    --skip-python) SKIP_PYTHON=true; shift ;;
    --skip-migrations) SKIP_MIGRATIONS=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage >&2; exit 64 ;;
  esac
done

if [ "$DRY_RUN" != "true" ]; then
  release_require_git_worktree "$ROOT"
fi

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
    if (Array.isArray(value)) process.stdout.write(value.length ? `${value.join("\n")}\n` : "");
    else if (value === null || value === undefined) process.stdout.write("");
    else process.stdout.write(String(value));
  ' "$CLASSIFIER_JSON_FILE" "$expr"
}

resolve_base_for_changed() {
  if [ -n "$BASE_REF" ]; then
    printf '%s' "$BASE_REF"
    return
  fi
  json_get "baseRef"
}

CLASSIFIER_JSON_FILE="$(mktemp)"
trap 'rm -f "$CLASSIFIER_JSON_FILE"' EXIT

classifier_args=(--format json)
if [ -n "$BASE_REF" ]; then
  classifier_args+=(--base "$BASE_REF")
fi
if [ -n "$EXPLICIT_FILES" ]; then
  classifier_args+=(--files "$EXPLICIT_FILES")
fi

if ! scripts/changed-area-classifier.sh "${classifier_args[@]}" > "$CLASSIFIER_JSON_FILE"; then
  echo "⚠️  classifier failed — escalating to full gate" >&2
  printf '{"vitest":{"mode":"full","globs":[]},"pytest":{"globs":[]},"flags":{"pythonEngine":false,"migration":false},"cannotSkip":[],"baseRef":"%s"}\n' "${BASE_REF:-origin/main}" > "$CLASSIFIER_JSON_FILE"
fi

VITEST_MODE="$(json_get "vitest.mode")"
BASE_FOR_CHANGED="$(resolve_base_for_changed)"
PYTHON_ENGINE="$(json_get "flags.pythonEngine")"
MIGRATION_CHANGED="$(json_get "flags.migration")"
CANNOT_SKIP="$(json_get "cannotSkip")"

if [ "${NEXUS_FORCE_FULL_GATE:-0}" = "1" ] || [ "$FORCE_FULL" = "true" ]; then
  VITEST_MODE="full"
fi

echo "═══════════════════════════════════════════════"
echo "  Nexus risk gate"
echo "═══════════════════════════════════════════════"
echo "base: ${BASE_FOR_CHANGED:-unknown}"
echo "vitest mode: $VITEST_MODE"
if [ -n "$CANNOT_SKIP" ]; then
  echo "cannot-skip gates:"
  printf '  - %s\n' $CANNOT_SKIP
fi

if [ "$SKIP_TYPECHECK" != "true" ]; then
  run_cmd npx tsc --noEmit
fi

if printf '%s\n' "$CANNOT_SKIP" | grep -qx 'notification-apns-delivery-and-tenant'; then
  run_cmd scripts/notification-release-gate.sh
fi

case "$VITEST_MODE" in
  skip)
    REASON="$(json_get "vitest.skipReason")"
    echo "🧪 Vitest skipped: ${REASON:-classifier selected skip}"
    ;;
  full)
    run_cmd npx vitest run --reporter="$REPORTER"
    ;;
  changed-only)
    run_cmd npx vitest run --reporter="$REPORTER" --changed "$BASE_FOR_CHANGED"
    ;;
  focused)
    RAW_GLOBS=()
    while IFS= read -r glob; do
      [ -n "$glob" ] && RAW_GLOBS+=("$glob")
    done < <(json_get "vitest.globs")
    if [ "${#RAW_GLOBS[@]}" -eq 0 ]; then
      echo "⚠️  focused mode had no globs — escalating to full Vitest"
      run_cmd npx vitest run --reporter="$REPORTER"
    else
      FILTERED_GLOBS=""
      if [ "$DRY_RUN" = "true" ]; then
        FILTERED_GLOBS="${RAW_GLOBS[*]}"
      else
        FILTERED_GLOBS="$(node "$ROOT/scripts/filter-existing-vitest-globs.mjs" "${RAW_GLOBS[@]}" 2>/dev/null || true)"
      fi
      if [ -z "$FILTERED_GLOBS" ]; then
        echo "⚠️  focused globs matched no tests — escalating to full Vitest"
        run_cmd npx vitest run --reporter="$REPORTER"
      else
        # shellcheck disable=SC2086
        run_cmd npx vitest run --reporter="$REPORTER" $FILTERED_GLOBS
        run_cmd npx vitest run --reporter="$REPORTER" --changed "$BASE_FOR_CHANGED"
      fi
    fi
    ;;
  *)
    echo "⚠️  unknown vitest mode '$VITEST_MODE' — escalating to full Vitest"
    run_cmd npx vitest run --reporter="$REPORTER"
    ;;
esac

if [ "$PYTHON_ENGINE" = "true" ] && [ "$SKIP_PYTHON" != "true" ]; then
  PYTHON_BIN="${CONTENT_ENGINE_PYTHON:-}"
  if [ -z "$PYTHON_BIN" ]; then
    if [ -x "$ROOT/content-engine/.venv-codex313/bin/python" ]; then
      PYTHON_BIN="$ROOT/content-engine/.venv-codex313/bin/python"
    elif [ -x "$ROOT/content-engine/.venv313/bin/python" ]; then
      PYTHON_BIN="$ROOT/content-engine/.venv313/bin/python"
    elif [ -x "$ROOT/content-engine/.venv/bin/python" ]; then
      PYTHON_BIN="$ROOT/content-engine/.venv/bin/python"
    else
      PYTHON_BIN="python3"
    fi
  fi
  run_cmd "$PYTHON_BIN" -m pytest "$ROOT/content-engine/tests"
fi

if [ "$MIGRATION_CHANGED" = "true" ] && [ "$SKIP_MIGRATIONS" != "true" ]; then
  run_cmd node scripts/migration-safety-check.mjs --base "$BASE_FOR_CHANGED" --changed-only
fi

if [ "${NEXUS_RISK_GATE_ASSERT_CANNOT_SKIP_DASHBOARD:-0}" = "1" ] && [ -n "$CANNOT_SKIP" ]; then
  run_cmd scripts/cannot-skip-gate-dashboard.sh --base "$BASE_FOR_CHANGED"
fi

echo "✅ risk gate complete"
