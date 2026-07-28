#!/usr/bin/env bash
set -euo pipefail

# Resolve the only safe comparison base for CI change classification.
# An empty result is intentional: callers must reject classification whenever
# the pushed/PR range cannot be proved. Automatic full-suite fallback is
# intentionally disabled.

ROOT="${NEXUS_CI_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
EVENT_NAME="${EVENT_NAME:-}"
ZERO_SHA="0000000000000000000000000000000000000000"

resolve_commit() {
  git -C "$ROOT" rev-parse --verify --quiet "${1}^{commit}" 2>/dev/null
}

case "$EVENT_NAME" in
  pull_request)
    PR_BASE_REF="${PR_BASE_REF:-}"
    PR_HEAD_SHA="${PR_HEAD_SHA:-}"
    if [ -n "$PR_BASE_REF" ] && [ -n "$PR_HEAD_SHA" ] \
      && resolve_commit "origin/$PR_BASE_REF" >/dev/null \
      && resolve_commit "$PR_HEAD_SHA" >/dev/null; then
      git -C "$ROOT" merge-base "origin/$PR_BASE_REF" "$PR_HEAD_SHA" 2>/dev/null || true
    fi
    ;;
  push)
    PUSH_BEFORE_SHA="${PUSH_BEFORE_SHA:-}"
    if [ -n "$PUSH_BEFORE_SHA" ] && [ "$PUSH_BEFORE_SHA" != "$ZERO_SHA" ] \
      && resolve_commit "$PUSH_BEFORE_SHA" >/dev/null \
      && git -C "$ROOT" merge-base --is-ancestor "$PUSH_BEFORE_SHA" HEAD 2>/dev/null; then
      printf '%s\n' "$PUSH_BEFORE_SHA"
    fi
    ;;
  *)
    # Manual/unknown events do not carry a trustworthy comparison range.
    ;;
esac
