#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# workspace-docs-mirror.sh — Snapshot workspace canonical docs into engine
#
# Closes ENG-EXC-O8 (workspace `docs/` is NOT a git repo): the workspace-level
# canonical docs are filesystem-only artifacts. Without a backup, a careless
# `rm` or rename loses canonical truth (AGENT_PROCESS_STANDARD.md,
# CURRENT_RELEASE_STATE.md, OPEN_ITEMS.md, etc.).
#
# This script does a ONE-WAY mirror from the workspace into:
#   engine/docs/_workspace-mirror/<workspace-relative-path>
#
# The workspace remains the source of truth. The mirror is a versioned
# snapshot that travels with engine commits.
#
# Usage:
#   ./scripts/workspace-docs-mirror.sh         # snapshot (writes mirror)
#   ./scripts/workspace-docs-mirror.sh --check # diff-check, exits 1 if drift
#   ./scripts/workspace-docs-mirror.sh --dry-run
#
# Files mirrored:
#   - <workspaceRoot>/CLAUDE.md
#   - <workspaceRoot>/AGENTS.md
#   - <workspaceRoot>/README.md
#   - <workspaceRoot>/docs/**/*.md
#   - <workspaceRoot>/docs/release/release-identity.json
#
# Excluded:
#   - <workspaceRoot>/docs/archive/   (already historical; lives elsewhere)
#   - <workspaceRoot>/worktrees/      (parallel checkouts, not canonical)
#
# Exit codes:
#   0 — mirror is in sync (or was just refreshed)
#   1 — mirror drift detected (use --check)
#   2 — usage / unexpected error
# ─────────────────────────────────────────────────────
set -euo pipefail

ENGINE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_WORKSPACE_ROOT="$(cd "$ENGINE_ROOT/.." && pwd)"
OFFICIAL_WORKSPACE_ROOT="/Users/felipedominguez/Desktop/Nexus Hub"
if [ -n "${NEXUS_WORKSPACE_ROOT:-}" ]; then
  WORKSPACE_ROOT="$NEXUS_WORKSPACE_ROOT"
elif [ -f "$OFFICIAL_WORKSPACE_ROOT/docs/DOCS_INDEX.md" ]; then
  WORKSPACE_ROOT="$OFFICIAL_WORKSPACE_ROOT"
else
  WORKSPACE_ROOT="$DEFAULT_WORKSPACE_ROOT"
fi
MIRROR_ROOT="$ENGINE_ROOT/docs/_workspace-mirror"

MODE="snapshot"
while [ $# -gt 0 ]; do
  case "$1" in
    --check)   MODE="check"; shift;;
    --dry-run) MODE="dry-run"; shift;;
    -h|--help)
      sed -n '2,40p' "$0" | sed 's/^# \?//'
      exit 0;;
    *) echo "Unknown arg: $1" >&2; exit 2;;
  esac
done

if [ ! -d "$WORKSPACE_ROOT" ]; then
  echo "Workspace not found at $WORKSPACE_ROOT" >&2
  exit 2
fi

# Collect source files. Each line: <relative-path>\t<absolute-source>
collect_sources() {
  # Top-level markdown
  for top in CLAUDE.md AGENTS.md README.md; do
    if [ -f "$WORKSPACE_ROOT/$top" ]; then
      printf '%s\t%s\n' "$top" "$WORKSPACE_ROOT/$top"
    fi
  done
  # docs/ tree (excluding archive/)
  if [ -d "$WORKSPACE_ROOT/docs" ]; then
    while IFS= read -r f; do
      rel="docs/${f#"$WORKSPACE_ROOT/docs/"}"
      printf '%s\t%s\n' "$rel" "$f"
    done < <(find "$WORKSPACE_ROOT/docs" \
      -type f \
      \( -name '*.md' -o -name 'release-identity.json' \) \
      -not -path '*/archive/*' \
      -not -path '*/.git/*' \
      | sort)
  fi
}

mkdir -p "$MIRROR_ROOT"

# 1. Track every existing mirror file so we can prune leftovers from prior runs.
EXISTING_MIRROR=$(mktemp)
PRESENT_SOURCES=$(mktemp)
trap 'rm -f "$EXISTING_MIRROR" "$PRESENT_SOURCES"' EXIT

if [ -d "$MIRROR_ROOT" ]; then
  ( cd "$MIRROR_ROOT" && find . -type f \( -name '*.md' -o -name '*.json' \) \
      -not -name 'README.md' \
      | sed 's|^\./||' | sort ) >"$EXISTING_MIRROR"
fi

DRIFT_FILES=()
NEW_FILES=()
COPIED=0

while IFS=$'\t' read -r rel src; do
  echo "$rel" >>"$PRESENT_SOURCES"
  dest="$MIRROR_ROOT/$rel"
  if [ ! -f "$dest" ]; then
    NEW_FILES+=("$rel")
    if [ "$MODE" = "snapshot" ]; then
      mkdir -p "$(dirname "$dest")"
      cp "$src" "$dest"
      COPIED=$((COPIED + 1))
    fi
    continue
  fi
  if ! cmp -s "$src" "$dest"; then
    DRIFT_FILES+=("$rel")
    if [ "$MODE" = "snapshot" ]; then
      cp "$src" "$dest"
      COPIED=$((COPIED + 1))
    fi
  fi
done < <(collect_sources)

# Pruning: any mirror file with no corresponding source is orphaned.
ORPHAN_FILES=()
sort -u "$PRESENT_SOURCES" -o "$PRESENT_SOURCES"
while IFS= read -r mirrored; do
  [ -z "$mirrored" ] && continue
  if ! grep -Fxq "$mirrored" "$PRESENT_SOURCES"; then
    ORPHAN_FILES+=("$mirrored")
    if [ "$MODE" = "snapshot" ]; then
      rm -f "$MIRROR_ROOT/$mirrored"
    fi
  fi
done <"$EXISTING_MIRROR"

# Write a small README inside the mirror once.
if [ "$MODE" = "snapshot" ] && [ ! -f "$MIRROR_ROOT/README.md" ]; then
  cat > "$MIRROR_ROOT/README.md" <<'README'
# Workspace docs mirror

This directory is a one-way snapshot of workspace-level canonical docs that
live OUTSIDE any git repo (the workspace `docs/` is not git-tracked per
existing convention).

**Source of truth**: `<workspaceRoot>/docs/`, `<workspaceRoot>/CLAUDE.md`,
`<workspaceRoot>/AGENTS.md`, `<workspaceRoot>/README.md`.

**Purpose**: durability. If the workspace `docs/` directory is removed or
diverges, the mirror gives a recoverable snapshot pinned to the engine
commit history.

**Refresh**: `engine/scripts/workspace-docs-mirror.sh` (run by the weekly
housekeeping job; can be run manually).

**Drift detection**: `engine/scripts/workspace-docs-mirror.sh --check`
exits 1 if the workspace is ahead of the mirror.

**Do NOT edit files in this directory**. Edits are overwritten on the
next mirror refresh. Edit the workspace source instead.
README
fi

# Output summary
case "$MODE" in
  snapshot)
    echo "workspace-docs-mirror: snapshot complete"
    echo "  files copied/refreshed: $COPIED"
    echo "  new files added:        ${#NEW_FILES[@]}"
    echo "  orphan files pruned:    ${#ORPHAN_FILES[@]}"
    if [ "${#DRIFT_FILES[@]}" -gt 0 ]; then
      echo "  drift refreshed:"
      for f in "${DRIFT_FILES[@]}"; do echo "    - $f"; done
    fi
    if [ "${#NEW_FILES[@]}" -gt 0 ]; then
      echo "  new mirrored:"
      for f in "${NEW_FILES[@]}"; do echo "    - $f"; done
    fi
    if [ "${#ORPHAN_FILES[@]}" -gt 0 ]; then
      echo "  pruned (no source):"
      for f in "${ORPHAN_FILES[@]}"; do echo "    - $f"; done
    fi
    exit 0
    ;;
  dry-run)
    echo "workspace-docs-mirror: dry-run"
    echo "  would copy/refresh: ${#DRIFT_FILES[@]}"
    echo "  would add new:      ${#NEW_FILES[@]}"
    echo "  would prune orphan: ${#ORPHAN_FILES[@]}"
    exit 0
    ;;
  check)
    drift_total=$(( ${#DRIFT_FILES[@]} + ${#NEW_FILES[@]} + ${#ORPHAN_FILES[@]} ))
    if [ "$drift_total" -eq 0 ]; then
      echo "workspace-docs-mirror: in sync"
      exit 0
    fi
    echo "workspace-docs-mirror: DRIFT DETECTED" >&2
    if [ "${#DRIFT_FILES[@]}" -gt 0 ]; then
      echo "  modified in workspace, mirror stale:" >&2
      for f in "${DRIFT_FILES[@]}"; do echo "    - $f" >&2; done
    fi
    if [ "${#NEW_FILES[@]}" -gt 0 ]; then
      echo "  added in workspace, missing in mirror:" >&2
      for f in "${NEW_FILES[@]}"; do echo "    - $f" >&2; done
    fi
    if [ "${#ORPHAN_FILES[@]}" -gt 0 ]; then
      echo "  removed from workspace, still in mirror:" >&2
      for f in "${ORPHAN_FILES[@]}"; do echo "    - $f" >&2; done
    fi
    echo "" >&2
    echo "Run: engine/scripts/workspace-docs-mirror.sh   (to refresh)" >&2
    exit 1
    ;;
esac
