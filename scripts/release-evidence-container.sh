#!/usr/bin/env bash
# Produce or validate release evidence inside the release-test container while
# bind-mounting the checkout so git metadata is available. This is evidence
# environment control, not a production parity claim.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

IMAGE="${NEXUS_RELEASE_TEST_IMAGE:-nexus-hub-release-test:local}"
SKIP_BUILD="${NEXUS_RELEASE_TEST_SKIP_BUILD:-0}"

if [ "$SKIP_BUILD" != "1" ]; then
  DOCKER_BUILDKIT=1 docker build -f Dockerfile.release-test -t "$IMAGE" .
fi

docker_env=(
  -e CI=1
  -e TELEGRAM_BOT_TOKEN=test_token
  -e TELEGRAM_ALLOWED_USER_IDS=123456789
  -e OWNER_TELEGRAM_ID=123456789
  -e DATABASE_PATH=:memory:
  -e NEXUS_LOCAL_ALLOW_MODEL_CALLS=0
)

for name in \
  NEXUS_RELEASE_EVIDENCE_PATH \
  NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PEM \
  NEXUS_RELEASE_EVIDENCE_PUBLIC_KEY_PEM \
  NEXUS_RELEASE_EVIDENCE_KEY_ID \
  NEXUS_RELEASE_EVIDENCE_MAX_AGE_S \
  NEXUS_RELEASE_EVIDENCE_EXPIRES_HOURS \
  NEXUS_RELEASE_EVIDENCE_ALLOW_UNSIGNED \
  NEXUS_RELEASE_VERDICT \
  NEXUS_RELEASE_INCLUDES_IOS \
  NEXUS_RELEASE_IOS_SHA \
  NEXUS_RELEASE_IOS_BUILD_HASH \
  NEXUS_RELEASE_TYPECHECK_RESULT \
  NEXUS_RELEASE_BUILD_RESULT \
  NEXUS_RELEASE_VITEST_RESULT \
  NEXUS_RELEASE_PYTEST_RESULT \
  NEXUS_RELEASE_SCIENCE_POLICY_RESULT \
  NEXUS_RELEASE_MIGRATIONS_RESULT \
  NEXUS_RELEASE_CANNOT_SKIP_DASHBOARD_RESULT \
  NEXUS_RELEASE_SMOKE_RESULT \
  NEXUS_RELEASE_IOS_RESULT \
  NEXUS_RELEASE_VITEST_TEST_COUNT \
  NEXUS_RELEASE_PYTEST_TEST_COUNT \
  NEXUS_RELEASE_IOS_TEST_COUNT \
  NEXUS_RELEASE_CANNOT_SKIP
do
  value="${!name-}"
  if [ -n "$value" ]; then
    docker_env+=(-e "$name=$value")
  fi
done

if [ -n "${NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PATH:-}" ]; then
  private_path="$NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PATH"
  if [[ "$private_path" = "$ROOT"/* ]]; then
    private_path="/workspace/${private_path#"$ROOT"/}"
  fi
  docker_env+=(-e "NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PATH=$private_path")
fi

if [ -n "${NEXUS_RELEASE_EVIDENCE_PUBLIC_KEY_PATH:-}" ]; then
  public_path="$NEXUS_RELEASE_EVIDENCE_PUBLIC_KEY_PATH"
  if [[ "$public_path" = "$ROOT"/* ]]; then
    public_path="/workspace/${public_path#"$ROOT"/}"
  fi
  docker_env+=(-e "NEXUS_RELEASE_EVIDENCE_PUBLIC_KEY_PATH=$public_path")
fi

docker run --rm \
  "${docker_env[@]}" \
  -v "$ROOT:/workspace" \
  -w /workspace \
  "$IMAGE" \
  node scripts/release-evidence.mjs "$@" --root /workspace
