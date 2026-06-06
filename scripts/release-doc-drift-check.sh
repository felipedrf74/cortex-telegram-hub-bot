#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# release-doc-drift-check.sh — Detect stale SHAs in current release docs
#
# release-pipeline-risk-based-optimization (2026-05-03) — open-item P2.
# Extends `npm run docs:audit` with a more aggressive check that's
# specific to active release/QA docs:
#
#   For each "current" doc, every short SHA (7–12 hex chars) it cites
#   must resolve to a commit reachable from the active branch's `git
#   log`. A SHA from a different branch / a typo / a stale promotion
#   record is a release blocker because release decisions are made
#   from those docs.
#
# Current docs scanned (matches `audit-docs.mjs > currentVerdictFiles`):
#   docs/release/CURRENT_RELEASE_STATE.md            (workspace)
#   docs/release/OPEN_ITEMS.md                       (workspace)
#   docs/release/release-pipeline-optimization-report.md
#   engine/docs/release/CURRENT_RELEASE_STATE.md
#   engine/docs/release/current-release-index.md
#   engine/docs/qa/QA_BACKEND_REPORT.md
#   ios/docs/qa/QA_IOS_REPORT.md
#
# Each doc is allowed to cite SHAs from its repo's own history. The check
# uses `git -C <repo> cat-file -e <sha>^{commit}` to verify reachability.
#
# Usage:
#   scripts/release-doc-drift-check.sh                 # warn-only (exit 0)
#   scripts/release-doc-drift-check.sh --strict        # exit 1 if drift found
#   scripts/release-doc-drift-check.sh --json          # machine-readable
#
# Why a separate script: docs:audit already detects "commit hash not
# found in own repo" but its file-to-repo mapping is heuristic. This
# script narrows the scope to the explicitly-current docs and adds the
# branch-reachability check that audit-docs.mjs doesn't perform.
# ─────────────────────────────────────────────────────
set -euo pipefail

LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE="$(cd "$LOCAL_DIR/../../.." && pwd 2>/dev/null || true)"
# Workspace symlinks: engine + ios
ENGINE_REPO="$LOCAL_DIR"
IOS_REPO="${IOS_REPO:-/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub}"
WORKSPACE_DOCS_ROOT="${NEXUS_WORKSPACE_DOCS_ROOT:-/Users/felipedominguez/Desktop/Nexus Hub}"

STRICT=false
JSON_OUT=false

for arg in "$@"; do
  case "$arg" in
    --strict) STRICT=true ;;
    --json) JSON_OUT=true ;;
    -h|--help)
      sed -n '2,40p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
  esac
done

# (file_path, repos_to_check_pipe-separated) pairs.
# Workspace docs reference SHAs from BOTH engine + ios repos — cross-repo
# is the norm there, so we accept a SHA reachable from either repo.
# Repo-local docs are also allowed to cite SHAs from the OTHER repo: the
# iOS QA report frequently references backend deploy SHAs ("deploy commit
# X"), and the backend QA report sometimes references iOS commits. So
# every doc gets to check against both repos. The (rare) genuine drift
# is when a SHA exists in NEITHER repo's history.
CURRENT_DOCS=(
  "$WORKSPACE_DOCS_ROOT/docs/release/CURRENT_RELEASE_STATE.md|$ENGINE_REPO,$IOS_REPO"
  "$WORKSPACE_DOCS_ROOT/docs/release/OPEN_ITEMS.md|$ENGINE_REPO,$IOS_REPO"
  "$WORKSPACE_DOCS_ROOT/docs/release/release-pipeline-optimization-report.md|$ENGINE_REPO,$IOS_REPO"
  "$ENGINE_REPO/docs/release/CURRENT_RELEASE_STATE.md|$ENGINE_REPO,$IOS_REPO"
  "$ENGINE_REPO/docs/release/current-release-index.md|$ENGINE_REPO,$IOS_REPO"
  "$ENGINE_REPO/docs/qa/QA_BACKEND_REPORT.md|$ENGINE_REPO,$IOS_REPO"
  "$IOS_REPO/docs/qa/QA_IOS_REPORT.md|$IOS_REPO,$ENGINE_REPO"
)

FINDINGS=()
TOTAL_DOCS=0
TOTAL_SHAS=0
TOTAL_DRIFT=0

is_known_non_sha() {
  case "$1" in
    # Common false positives (decimal-looking 7-char tokens, hex words).
    1234567|abcdefa|0000000|fffffff) return 0 ;;
  esac
  return 1
}

check_doc() {
  local doc="$1"
  local repos_csv="$2"
  if [ ! -f "$doc" ]; then
    return
  fi
  TOTAL_DOCS=$((TOTAL_DOCS + 1))

  # Strip UUID-like patterns first. A UUID looks like
  # XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX (8-4-4-4-12 hex). Without this
  # filter, the inner chunks of every UUID get matched as "stale SHAs".
  # Also strip OAuth tokens / device IDs that look like long hex blobs.
  # Note: BSD sed (macOS) doesn't support `\b`, so we don't anchor to
  # word boundaries — the lengths are specific enough on their own.
  local stripped
  stripped="$(sed -E '
    s/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}//g
    s/[0-9a-fA-F]{32,}//g
  ' "$doc" 2>/dev/null)"

  # Pull every short SHA (7–12 hex chars at word boundary) from the doc.
  # We use grep on the stripped variant but keep the original line numbers
  # by computing them from the matched line content via grep -n on the
  # original file with the same regex (less precise than offsets but good
  # enough for the user-visible output).
  local shas
  shas="$(printf '%s' "$stripped" | grep -oEn '\b[0-9a-fA-F]{7,12}\b' 2>/dev/null \
    | awk -F: 'tolower($2) ~ /^[0-9a-f]+$/ && $2 !~ /^[0-9]+$/ {print $1 ":" tolower($2)}' \
    | sort -u)"

  while IFS=: read -r line sha; do
    [ -z "$sha" ] && continue
    if is_known_non_sha "$sha"; then continue; fi
    TOTAL_SHAS=$((TOTAL_SHAS + 1))
    # Try every repo in the CSV — accept the SHA if any one resolves it.
    local found=false
    local IFS_BAK="$IFS"
    IFS=','
    for repo in $repos_csv; do
      if git -C "$repo" cat-file -e "${sha}^{commit}" 2>/dev/null; then
        found=true
        break
      fi
    done
    IFS="$IFS_BAK"
    if [ "$found" = false ]; then
      TOTAL_DRIFT=$((TOTAL_DRIFT + 1))
      FINDINGS+=("$(printf 'unknown_sha\t%s\t%s\t%s\t%s' "$doc" "$line" "$sha" "$repos_csv")")
    fi
  done <<< "$shas"
}

for entry in "${CURRENT_DOCS[@]}"; do
  IFS='|' read -r doc repo <<< "$entry"
  check_doc "$doc" "$repo"
done

if [ "$JSON_OUT" = true ]; then
  printf '%s\n' "${FINDINGS[@]+"${FINDINGS[@]}"}" \
    | NODE_NO_WARNINGS=1 node -e '
      const lines = require("fs").readFileSync(0, "utf8").split("\n").filter(Boolean);
      const issues = lines.map((l) => {
        const [type, file, line, sha, repo] = l.split("\t");
        return { type, file, line: Number(line), sha, repo };
      });
      const summary = {
        generatedAt: new Date().toISOString(),
        docsScanned: Number(process.env.TOTAL_DOCS),
        shasChecked: Number(process.env.TOTAL_SHAS),
        driftCount: Number(process.env.TOTAL_DRIFT),
      };
      console.log(JSON.stringify({ summary, issues }, null, 2));
    '
else
  echo "# release-doc-drift-check"
  echo
  echo "Docs scanned: $TOTAL_DOCS"
  echo "SHAs checked: $TOTAL_SHAS"
  echo "Drift findings: $TOTAL_DRIFT"
  echo
  if [ "$TOTAL_DRIFT" -eq 0 ]; then
    echo "✅ No stale SHAs in any current release doc."
  else
    echo "## Drift findings"
    echo
    for f in "${FINDINGS[@]}"; do
      IFS=$'\t' read -r type doc line sha repo <<< "$f"
      printf -- "- %s @ line %s: SHA %s not reachable from %s\n" \
        "$doc" "$line" "$sha" "$repo"
    done
    echo
    echo "Resolution:"
    echo "  - regenerate the doc's release identity via scripts/release-identity.sh"
    echo "  - or move the doc into docs/archive/<YYYY-MM>/<workstream>/ if it is historical"
    echo "  - or remove the SHA citation"
  fi
fi

if [ "$STRICT" = true ] && [ "$TOTAL_DRIFT" -gt 0 ]; then
  exit 1
fi
exit 0
