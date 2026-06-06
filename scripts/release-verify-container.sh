#!/usr/bin/env bash
# Build and run the release-test container. This is a deterministic contract
# gate, not a production parity claim.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

IMAGE="${NEXUS_RELEASE_TEST_IMAGE:-nexus-hub-release-test:local}"
SKIP_BUILD="${NEXUS_RELEASE_TEST_SKIP_BUILD:-0}"
VERIFY_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --shard)
      VERIFY_ARGS+=("$1" "$2")
      shift 2
      ;;
    --skip-pytest|--skip-vitest)
      VERIFY_ARGS+=("$1")
      shift
      ;;
    -h|--help)
      sed -n '2,80p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 64 ;;
  esac
done

if [ "$SKIP_BUILD" != "1" ]; then
  DOCKER_BUILDKIT=1 docker build -f Dockerfile.release-test -t "$IMAGE" .
fi

cmd=(./scripts/release-verify.sh)
git_mount=()
if [ -e "$ROOT/.git" ]; then
  git_mount=(-v "$ROOT/.git:/app/.git:ro")
fi

docker run --rm \
  "${git_mount[@]}" \
  -e CI=1 \
  -e TELEGRAM_BOT_TOKEN=test_token \
  -e TELEGRAM_ALLOWED_USER_IDS=123456789 \
  -e OWNER_TELEGRAM_ID=123456789 \
  -e DATABASE_PATH=:memory: \
  "$IMAGE" "${cmd[@]}" "${VERIFY_ARGS[@]}"
