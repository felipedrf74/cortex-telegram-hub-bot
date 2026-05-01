#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IOS_REPO="${IOS_REPO:-/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub}"
FORMAT="${1:-markdown}"

branch_for() {
  git -C "$1" branch --show-current 2>/dev/null || printf 'unknown'
}

sha_for() {
  git -C "$1" rev-parse --short HEAD 2>/dev/null || printf 'unknown'
}

dirty_for() {
  if [ ! -d "$1/.git" ]; then
    printf 'unknown'
    return
  fi
  if [ -n "$(git -C "$1" status --short)" ]; then
    printf 'dirty'
  else
    printf 'clean'
  fi
}

version_for() {
  if [ -f "$1/package.json" ]; then
    node -p "require('$1/package.json').version" 2>/dev/null || printf 'unknown'
  else
    printf 'n/a'
  fi
}

migration_count_for() {
  if [ -d "$1/migrations" ]; then
    find "$1/migrations" -type f -name '*.sql' | wc -l | tr -d ' '
  else
    printf 'n/a'
  fi
}

timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
backend_branch="$(branch_for "$ROOT")"
backend_sha="$(sha_for "$ROOT")"
backend_dirty="$(dirty_for "$ROOT")"
backend_version="$(version_for "$ROOT")"
backend_migrations="$(migration_count_for "$ROOT")"

ios_branch="$(branch_for "$IOS_REPO")"
ios_sha="$(sha_for "$IOS_REPO")"
ios_dirty="$(dirty_for "$IOS_REPO")"

case "$FORMAT" in
  json|--json)
    node <<JSON
const payload = {
  generatedAt: "$timestamp",
  backend: {
    path: "$ROOT",
    branch: "$backend_branch",
    commit: "$backend_sha",
    dirtyState: "$backend_dirty",
    packageVersion: "$backend_version",
    migrationCount: "$backend_migrations"
  },
  ios: {
    path: "$IOS_REPO",
    branch: "$ios_branch",
    commit: "$ios_sha",
    dirtyState: "$ios_dirty"
  }
};
console.log(JSON.stringify(payload, null, 2));
JSON
    ;;
  markdown|--markdown)
    cat <<EOF
| Area | Path | Branch | Commit | Dirty state | Version | Migrations |
| --- | --- | --- | --- | --- | --- | --- |
| Backend | \`$ROOT\` | \`$backend_branch\` | \`$backend_sha\` | \`$backend_dirty\` | \`$backend_version\` | \`$backend_migrations\` |
| iOS | \`$IOS_REPO\` | \`$ios_branch\` | \`$ios_sha\` | \`$ios_dirty\` | n/a | n/a |

Generated at: \`$timestamp\`
EOF
    ;;
  *)
    echo "Usage: scripts/release-identity.sh [markdown|json]" >&2
    exit 64
    ;;
esac
