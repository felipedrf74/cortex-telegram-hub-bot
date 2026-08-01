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
#      and a tee buffer. Exact/hardened callers may request ordinary-file
#      capture + replay with NEXUS_SMOKE_BUFFERED_CAPTURE=1.
#   2. Captures exit code.
#   3. Writes a JSON evidence file to:
#        engine/.local/release/smoke-evidence/[nonevidentiary-]<smoke-name>-<sha>[-<artifact-digest>]-<utc>.json
#      Schema:
#        {
#          version, smokeName, runStartedAt, runCompletedAt,
#          branch, sha, runtimeSha, artifactDigest, releaseRole,
#          nonEvidentiary,
#          verdict ('passed'|'failed'|'blocked'),
#          exitCode, durationS,
#          stdoutTail, stderrTail
#        }
#   4. Exits with the same code as the wrapped command.
#
# Disable with NEXUS_SMOKE_EVIDENCE=0. The wrapped command runs either way;
# only the side-effect JSON write is skipped.
#
# Set NEXUS_SMOKE_NON_EVIDENTIARY=1 for runs that are NOT release proof (local
# dry-runs built from a source checkout). The marker lands in both the evidence
# filename and the payload so such a receipt can never be read as staging proof.
#
# Exit-code → verdict mapping:
#   0    -> passed
#   2    -> blocked (e.g. provider-credential blocked, intentional gate)
#   any  -> failed
# (2 mirrors the convention in `training-calendar-staging-smoke.ts`.)
#
# This wrapper's own hard refusals exit 3, never 2, so a refusal is never
# mistaken for an intentional by-design block by a caller.
# ─────────────────────────────────────────────────────
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <smoke-name> <command> [args...]" >&2
  exit 64
fi

SMOKE_NAME="$1"
shift

# Distinct from 2 so a refusal can never be read as "blocked by design".
GUARD_REFUSAL_EXIT=3

LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EVIDENCE_DIR="${NEXUS_SMOKE_EVIDENCE_DIR:-$LOCAL_DIR/.local/release/smoke-evidence}"
EVIDENCE_ENABLED="${NEXUS_SMOKE_EVIDENCE:-1}"
EXACT_IDENTITY_REQUIRED="${NEXUS_SMOKE_REQUIRE_EXACT_IDENTITY:-0}"
NON_EVIDENTIARY="${NEXUS_SMOKE_NON_EVIDENTIARY:-0}"

GIT_HEAD_SHA="$(cd "$LOCAL_DIR" && git rev-parse HEAD 2>/dev/null || echo unknown)"
GIT_SHORT_SHA="$(cd "$LOCAL_DIR" && git rev-parse --short HEAD 2>/dev/null || echo unknown)"
BRANCH="$(cd "$LOCAL_DIR" && git branch --show-current 2>/dev/null || echo unknown)"
RUNTIME_SHA="${NEXUS_RELEASE_SHA:-$GIT_HEAD_SHA}"
ARTIFACT_DIGEST="${NEXUS_RELEASE_ARTIFACT_SHA256:-}"
RELEASE_ROLE="${NEXUS_RELEASE_ROLE:-}"

if ! [[ "$RUNTIME_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  if [ "$EXACT_IDENTITY_REQUIRED" = "1" ]; then
    echo "Exact smoke evidence requires NEXUS_RELEASE_SHA=<full lowercase 40-hex SHA>." >&2
    exit "$GUARD_REFUSAL_EXIT"
  fi
  RUNTIME_SHA=unknown
fi
if [ -n "$ARTIFACT_DIGEST" ] && ! [[ "$ARTIFACT_DIGEST" =~ ^[0-9a-f]{64}$ ]]; then
  if [ "$EXACT_IDENTITY_REQUIRED" = "1" ]; then
    echo "Exact smoke evidence requires NEXUS_RELEASE_ARTIFACT_SHA256=<full lowercase 64-hex digest>." >&2
    exit "$GUARD_REFUSAL_EXIT"
  fi
  ARTIFACT_DIGEST=''
fi
if [ "$EXACT_IDENTITY_REQUIRED" = "1" ]; then
  if [ -z "$ARTIFACT_DIGEST" ] || { [ "$RELEASE_ROLE" != "staging" ] && [ "$RELEASE_ROLE" != "production" ]; }; then
    echo "Exact smoke evidence requires an artifact digest and staging/production release role." >&2
    exit "$GUARD_REFUSAL_EXIT"
  fi
  if [ "$NON_EVIDENTIARY" = "1" ]; then
    echo "A run cannot be both exact release evidence and non-evidentiary." >&2
    exit "$GUARD_REFUSAL_EXIT"
  fi
fi
LEGACY_SHA="$GIT_SHORT_SHA"
if [ "$EXACT_IDENTITY_REQUIRED" = "1" ] || [ "$LEGACY_SHA" = "unknown" ]; then
  LEGACY_SHA="$RUNTIME_SHA"
fi

START_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
START_EPOCH="$(date -u +%s)"

STDOUT_FILE="$(mktemp -t nx-smoke-stdout.XXXXXX)"
STDERR_FILE="$(mktemp -t nx-smoke-stderr.XXXXXX)"
cleanup() {
  rm -f "$STDOUT_FILE" "$STDERR_FILE"
}
trap cleanup EXIT

set +e
if [ "$EXACT_IDENTITY_REQUIRED" = "1" ] || [ "${NEXUS_SMOKE_BUFFERED_CAPTURE:-0}" = "1" ]; then
  # Avoid process-substitution FIFOs: hardened release launch environments
  # may deny /dev/fd even though the wrapped command itself is allowed.
  "$@" >"$STDOUT_FILE" 2>"$STDERR_FILE"
else
  # Preserve the generic wrapper's historical live-output behavior.
  "$@" > >(tee "$STDOUT_FILE") 2> >(tee "$STDERR_FILE" >&2)
fi
EXIT_CODE=$?
# Replay the buffered output while errexit is still off, and tolerate a failed
# replay (deleted buffer, closed pipe). The wrapped command's exit status is
# already captured and must be what this wrapper reports.
if [ "$EXACT_IDENTITY_REQUIRED" = "1" ] || [ "${NEXUS_SMOKE_BUFFERED_CAPTURE:-0}" = "1" ]; then
  cat "$STDOUT_FILE" || true
  cat "$STDERR_FILE" >&2 || true
fi
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
  if ! mkdir -p "$EVIDENCE_DIR" 2>/dev/null; then
    echo "Failed to create smoke evidence directory: $EVIDENCE_DIR" >&2
    if [ "$EXACT_IDENTITY_REQUIRED" = "1" ]; then exit 1; fi
  fi
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  IDENTITY_SUFFIX="$LEGACY_SHA"
  if [ -n "$ARTIFACT_DIGEST" ]; then
    IDENTITY_SUFFIX="${RUNTIME_SHA}-${ARTIFACT_DIGEST}"
  fi
  EVIDENCE_NAME="${SMOKE_NAME}"
  if [ "$NON_EVIDENTIARY" = "1" ]; then
    # A source-built dry-run carries a real-looking runtime/artifact identity;
    # the filename prefix keeps it from ever reading as release proof.
    EVIDENCE_NAME="nonevidentiary-${SMOKE_NAME}"
  fi
  EVIDENCE_FILE="$EVIDENCE_DIR/${EVIDENCE_NAME}-${IDENTITY_SUFFIX}-${STAMP}.json"

  # Build payload via node so JSON is properly escaped.
  STDOUT_TAIL="$(tail -c 4000 "$STDOUT_FILE" 2>/dev/null || true)"
  STDERR_TAIL="$(tail -c 4000 "$STDERR_FILE" 2>/dev/null || true)"

  export NX_SMOKE_NAME="$SMOKE_NAME"
  export NX_RUN_STARTED="$START_AT"
  export NX_RUN_COMPLETED="$END_AT"
  export NX_BRANCH="$BRANCH"
  export NX_SHA="$LEGACY_SHA"
  export NX_RUNTIME_SHA="$RUNTIME_SHA"
  export NX_ARTIFACT_DIGEST="$ARTIFACT_DIGEST"
  export NX_RELEASE_ROLE="$RELEASE_ROLE"
  export NX_NON_EVIDENTIARY="$NON_EVIDENTIARY"
  export NX_VERDICT="$VERDICT"
  export NX_EXIT_CODE="$EXIT_CODE"
  export NX_DURATION_S="$DURATION_S"
  export NX_STDOUT_TAIL="$STDOUT_TAIL"
  export NX_STDERR_TAIL="$STDERR_TAIL"

  NODE_NO_WARNINGS=1 node -e '
    const payload = {
      version: "2",
      smokeName: process.env.NX_SMOKE_NAME,
      runStartedAt: process.env.NX_RUN_STARTED,
      runCompletedAt: process.env.NX_RUN_COMPLETED,
      branch: process.env.NX_BRANCH,
      sha: process.env.NX_SHA,
      runtimeSha: process.env.NX_RUNTIME_SHA,
      artifactDigest: process.env.NX_ARTIFACT_DIGEST || null,
      releaseRole: process.env.NX_RELEASE_ROLE || null,
      nonEvidentiary: process.env.NX_NON_EVIDENTIARY === "1",
      verdict: process.env.NX_VERDICT,
      exitCode: Number(process.env.NX_EXIT_CODE),
      durationS: Number(process.env.NX_DURATION_S),
      stdoutTail: process.env.NX_STDOUT_TAIL || "",
      stderrTail: process.env.NX_STDERR_TAIL || "",
    };
    require("fs").writeFileSync(process.argv[1], JSON.stringify(payload, null, 2));
  ' "$EVIDENCE_FILE" 2>/dev/null \
    && echo "📝 Smoke evidence: $EVIDENCE_FILE" >&2 \
    || {
      echo "⚠️  Failed to write smoke evidence" >&2
      if [ "$EXACT_IDENTITY_REQUIRED" = "1" ]; then exit 1; fi
    }
fi

exit "$EXIT_CODE"
