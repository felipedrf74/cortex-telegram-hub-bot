#!/usr/bin/env bash
# Prepare a release commit before staging/prod deploy. This replaces the old
# deploy-time version bump so the staged artifact digest is the shipped digest.

set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/lib/release-gates.sh"
cd "$ROOT"

BUMP="patch"
EXPLICIT_VERSION=""
NO_COMMIT=false

while [ $# -gt 0 ]; do
  case "$1" in
    --patch|patch) BUMP="patch"; shift ;;
    --minor|minor) BUMP="minor"; shift ;;
    --major|major) BUMP="major"; shift ;;
    --version) EXPLICIT_VERSION="$2"; shift 2 ;;
    --no-commit) NO_COMMIT=true; shift ;;
    -h|--help)
      sed -n '2,80p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 64 ;;
  esac
done

release_require_git_worktree "$ROOT"
release_acquire_local_lock "$ROOT" "release-prep"
trap release_cleanup_all_locks EXIT

if ! release_require_clean_tree "$ROOT" >/tmp/nexus-release-prep-status.$$ 2>/dev/null; then
  echo "❌ Working tree must be clean before release-prep."
  cat /tmp/nexus-release-prep-status.$$ 2>/dev/null || true
  rm -f /tmp/nexus-release-prep-status.$$
  exit 1
fi
rm -f /tmp/nexus-release-prep-status.$$

OLD_VERSION="$(node -p "require('./package.json').version")"
if [ -n "$EXPLICIT_VERSION" ]; then
  npm version "$EXPLICIT_VERSION" --no-git-tag-version
else
  npm version "$BUMP" --no-git-tag-version
fi
NEW_VERSION="$(node -p "require('./package.json').version")"

echo "Prepared release version: $OLD_VERSION -> $NEW_VERSION"
echo "Running versioned artifact build check..."
npm run typecheck
npm run build
PREP_DIGEST="$(node scripts/release-artifact-manifest.mjs --digest)"
echo "Artifact digest: $PREP_DIGEST"

if [ "$NO_COMMIT" = true ]; then
  echo "Release prep complete without commit (--no-commit)."
  exit 0
fi

git add package.json package-lock.json
git commit -m "chore: prepare release $NEW_VERSION"
echo "Release prep committed. Deploy this commit to staging before production."
