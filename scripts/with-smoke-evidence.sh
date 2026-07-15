#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# with-smoke-evidence.sh — Wrap a smoke command, capture its outcome,
# write a JSON evidence file alongside other smokes.
#
# release-pipeline-risk-based-optimization (2026-05-03) — open-item P2.
#
# Usage:
#   scripts/with-smoke-evidence.sh <smoke-name> <command> [args...]
#
# Example:
#   scripts/with-smoke-evidence.sh training-calendar-staging \
#     node dist/tools/training-calendar-staging-smoke.js "$@"
#
# Behavior:
#   1. Runs <command> with stdout + stderr piped to BOTH the terminal
#      and a tee buffer.
#   2. Captures exit code.
#   3. Writes a JSON evidence file to:
#        engine/.local/release/smoke-evidence/<smoke-name>-<sha>-<utc>.json
#      Schema:
#        {
#          version, smokeName, runStartedAt, runCompletedAt,
#          branch, sha, verdict ('passed'|'failed'|'blocked'),
#          exitCode, durationS,
#          stdoutTail, stderrTail
#        }
#   4. Exits with the same code as the wrapped command.
#
# Disable with NEXUS_SMOKE_EVIDENCE=0. The wrapped command runs either way;
# only the side-effect JSON write is skipped.
#
# Exit-code → verdict mapping:
#   0    -> passed
#   2    -> blocked (e.g. provider-credential blocked, intentional gate)
#   any  -> failed
# (2 mirrors the convention in `training-calendar-staging-smoke.ts`.)
# ─────────────────────────────────────────────────────
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <smoke-name> <command> [args...]" >&2
  exit 64
fi

SMOKE_NAME="$1"
shift

LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EVIDENCE_DIR="$LOCAL_DIR/.local/release/smoke-evidence"
EVIDENCE_ENABLED="${NEXUS_SMOKE_EVIDENCE:-1}"

START_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
START_EPOCH="$(date -u +%s)"
HEAD_SHA="$(cd "$LOCAL_DIR" && git rev-parse --short HEAD 2>/dev/null || echo unknown)"
BRANCH="$(cd "$LOCAL_DIR" && git branch --show-current 2>/dev/null || echo unknown)"

STDOUT_FILE="$(mktemp -t nx-smoke-stdout.XXXXXX)"
STDERR_FILE="$(mktemp -t nx-smoke-stderr.XXXXXX)"
cleanup() {
  rm -f "$STDOUT_FILE" "$STDERR_FILE"
}
trap cleanup EXIT

# Run the wrapped command. Tee stdout + stderr so the user still sees them.
set +e
"$@" > >(tee "$STDOUT_FILE") 2> >(tee "$STDERR_FILE" >&2)
EXIT_CODE=$?
set -e

END_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
END_EPOCH="$(date -u +%s)"
DURATION_S=$((END_EPOCH - START_EPOCH))

case "$EXIT_CODE" in
  0) VERDICT="passed" ;;
  2) VERDICT="blocked" ;;
  *) VERDICT="failed" ;;
esac

if [ "$EVIDENCE_ENABLED" = "1" ]; then
  mkdir -p "$EVIDENCE_DIR" 2>/dev/null || true
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  EVIDENCE_FILE="$EVIDENCE_DIR/${SMOKE_NAME}-${HEAD_SHA}-${STAMP}.json"

  # Build payload via node so JSON is properly escaped.
  STDOUT_TAIL="$(tail -c 4000 "$STDOUT_FILE" 2>/dev/null || true)"
  STDERR_TAIL="$(tail -c 4000 "$STDERR_FILE" 2>/dev/null || true)"

  export NX_SMOKE_NAME="$SMOKE_NAME"
  export NX_RUN_STARTED="$START_AT"
  export NX_RUN_COMPLETED="$END_AT"
  export NX_BRANCH="$BRANCH"
  export NX_SHA="$HEAD_SHA"
  export NX_VERDICT="$VERDICT"
  export NX_EXIT_CODE="$EXIT_CODE"
  export NX_DURATION_S="$DURATION_S"
  export NX_STDOUT_TAIL="$STDOUT_TAIL"
  export NX_STDERR_TAIL="$STDERR_TAIL"

  NODE_NO_WARNINGS=1 node -e '
    const payload = {
      version: "1",
      smokeName: process.env.NX_SMOKE_NAME,
      runStartedAt: process.env.NX_RUN_STARTED,
      runCompletedAt: process.env.NX_RUN_COMPLETED,
      branch: process.env.NX_BRANCH,
      sha: process.env.NX_SHA,
      verdict: process.env.NX_VERDICT,
      exitCode: Number(process.env.NX_EXIT_CODE),
      durationS: Number(process.env.NX_DURATION_S),
      stdoutTail: process.env.NX_STDOUT_TAIL || "",
      stderrTail: process.env.NX_STDERR_TAIL || "",
    };
    require("fs").writeFileSync(process.argv[1], JSON.stringify(payload, null, 2));
  ' "$EVIDENCE_FILE" 2>/dev/null \
    && echo "📝 Smoke evidence: $EVIDENCE_FILE" >&2 \
    || echo "⚠️  Failed to write smoke evidence (non-fatal)" >&2
fi

exit "$EXIT_CODE"
