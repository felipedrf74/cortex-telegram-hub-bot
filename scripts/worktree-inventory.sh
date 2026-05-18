#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# worktree-inventory.sh — list local git worktrees with age + merge state
#
# Test-infra plan Phase H-2 (2026-05-18). Surfaces stale worktrees so
# parallel-agent setups don't accumulate cruft. Read-only by default;
# `--prune-merged` deletes worktrees whose branches are already in
# origin/main HEAD.
#
# Usage:
#   ./scripts/worktree-inventory.sh               # human-readable table
#   ./scripts/worktree-inventory.sh --json        # machine-readable JSON
#   ./scripts/worktree-inventory.sh --stale       # only worktrees >30 days old or merged
#   ./scripts/worktree-inventory.sh --prune-merged  # delete merged worktrees (with confirmation)
# ─────────────────────────────────────────────────────
set -euo pipefail

FORMAT="table"
ONLY_STALE=false
PRUNE_MERGED=false
STALE_DAYS=30

while [ $# -gt 0 ]; do
  case "$1" in
    --json) FORMAT="json"; shift;;
    --stale) ONLY_STALE=true; shift;;
    --prune-merged) PRUNE_MERGED=true; shift;;
    --stale-days) STALE_DAYS="$2"; shift 2;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \?//'
      exit 0;;
    *) echo "Unknown arg: $1" >&2; exit 1;;
  esac
done

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"
if [ -z "$ROOT" ]; then
  echo "Not a git repository" >&2
  exit 1
fi

# Fetch main quietly so is_merged accuracy is fresh.
git fetch origin main --quiet 2>/dev/null || true
MAIN_SHA="$(git rev-parse origin/main 2>/dev/null || git rev-parse main 2>/dev/null || echo "")"

NOW_EPOCH=$(date -u +%s)
STALE_THRESHOLD_S=$((STALE_DAYS * 86400))

# Collect worktrees.
WT_LINES=$(git worktree list --porcelain 2>/dev/null)
WT_PATHS=$(echo "$WT_LINES" | sed -n 's/^worktree //p')

emit_row_table() {
  local path="$1" branch="$2" last_commit_iso="$3" age_days="$4" merged="$5" disk_mb="$6"
  printf "%-80s  %-50s  %-12s  %-8s  %-6s  %s MB\n" "$path" "$branch" "$last_commit_iso" "${age_days}d" "$merged" "$disk_mb"
}

emit_row_json() {
  local path="$1" branch="$2" last_commit_iso="$3" age_days="$4" merged="$5" disk_mb="$6"
  ROWS_JSON+=("{\"path\":\"${path//\"/\\\"}\",\"branch\":\"${branch//\"/\\\"}\",\"lastCommit\":\"${last_commit_iso}\",\"ageDays\":${age_days},\"merged\":${merged},\"diskMb\":${disk_mb}}")
}

ROWS_JSON=()
if [ "$FORMAT" = "table" ]; then
  echo "Worktree inventory (stale threshold: ${STALE_DAYS} days)"
  echo "----------------------------------------------------------------------"
  emit_row_table "PATH" "BRANCH" "LAST_COMMIT" "AGE" "MERGED" "DISK"
fi

PRUNE_CANDIDATES=()

while IFS= read -r wt; do
  [ -z "$wt" ] && continue
  [ -d "$wt" ] || continue
  if ! cd "$wt" 2>/dev/null; then continue; fi
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
  head_sha=$(git rev-parse HEAD 2>/dev/null || echo "")
  last_commit_iso=$(git log -1 --format=%cI HEAD 2>/dev/null || echo "")
  # Use raw committer epoch from git (%ct) — avoids ISO-parse quirks on macOS
  # vs GNU date (macOS rejects the `+01:00` colon in %z; git --format=%cI emits
  # exactly that). %ct is already epoch seconds.
  last_commit_epoch=$(git log -1 --format=%ct HEAD 2>/dev/null || echo 0)
  age_s=$((NOW_EPOCH - last_commit_epoch))
  age_days=$((age_s / 86400))
  merged="false"
  if [ -n "$MAIN_SHA" ] && [ -n "$head_sha" ]; then
    if git merge-base --is-ancestor "$head_sha" "$MAIN_SHA" 2>/dev/null; then
      merged="true"
    fi
  fi
  disk_kb=$(du -sk "$wt" 2>/dev/null | awk '{print $1}' || echo 0)
  disk_mb=$((disk_kb / 1024))

  # Stale filter.
  if $ONLY_STALE; then
    if [ "$age_s" -lt "$STALE_THRESHOLD_S" ] && [ "$merged" = "false" ]; then
      continue
    fi
  fi

  if [ "$FORMAT" = "json" ]; then
    emit_row_json "$wt" "$branch" "$last_commit_iso" "$age_days" "$merged" "$disk_mb"
  else
    emit_row_table "$wt" "$branch" "$last_commit_iso" "$age_days" "$merged" "$disk_mb"
  fi

  if $PRUNE_MERGED && [ "$merged" = "true" ] && [ "$wt" != "$ROOT" ]; then
    PRUNE_CANDIDATES+=("$wt")
  fi
done <<EOF
$WT_PATHS
EOF

if [ "$FORMAT" = "json" ]; then
  printf '{"generatedAt":"%s","staleThresholdDays":%d,"worktrees":[' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$STALE_DAYS"
  if [ ${#ROWS_JSON[@]} -gt 0 ]; then
    printf '%s' "${ROWS_JSON[0]}"
    for ((i=1; i<${#ROWS_JSON[@]}; i++)); do printf ',%s' "${ROWS_JSON[$i]}"; done
  fi
  printf ']}\n'
fi

if $PRUNE_MERGED && [ ${#PRUNE_CANDIDATES[@]} -gt 0 ]; then
  echo ""
  echo "Pruning ${#PRUNE_CANDIDATES[@]} merged worktrees…"
  for wt in "${PRUNE_CANDIDATES[@]}"; do
    read -p "  Remove worktree $wt? [y/N] " yn
    case "$yn" in
      y|Y) git worktree remove "$wt" 2>&1 || echo "    (failed; left in place)";;
      *) echo "    skipped";;
    esac
  done
fi
