#!/usr/bin/env bash
# Resolve Docker Hub manifest-list digests and keep Compose image references
# immutable. This script never pulls, starts, or removes an image.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK_FILE="$ROOT/ops/sonarqube/images.lock.env"
COMPOSE_FILE="$ROOT/ops/sonarqube/compose.yaml"
ACTION=check
CURL_BIN="$(command -v curl 2>/dev/null || true)"
NODE_BIN="$(command -v node 2>/dev/null || true)"

SONAR_TAG=26.7.0.124771-community
POSTGRES_TAG=16

usage() {
  cat <<'EOF'
Usage: quality-sonar-resolve-images.sh [--check|--write|--verify-lock-only] [--lock-file <path>]

  --check             Resolve remote digests and require an exact lock match.
  --write             Resolve remote digests and atomically rewrite the lock.
  --verify-lock-only  Validate immutable lock syntax without network access.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) ACTION=check; shift ;;
    --write) ACTION=write; shift ;;
    --verify-lock-only) ACTION=verify; shift ;;
    --lock-file) LOCK_FILE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 64 ;;
  esac
done

[[ "$LOCK_FILE" == /* ]] || LOCK_FILE="$ROOT/$LOCK_FILE"

read_lock_value() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key { print substr($0, index($0, "=") + 1); found=1; exit } END { if (!found) exit 1 }' "$LOCK_FILE"
}

validate_digest() {
  [[ "$1" =~ ^sha256:[0-9a-f]{64}$ ]]
}

verify_lock() {
  [ -f "$LOCK_FILE" ] && [ ! -L "$LOCK_FILE" ] || {
    echo "Sonar image lock must be a non-symlink regular file: $LOCK_FILE" >&2
    return 1
  }
  local sonar_tag postgres_tag sonar_image postgres_image sonar_digest postgres_digest
  sonar_tag="$(read_lock_value SONARQUBE_IMAGE_TAG)"
  postgres_tag="$(read_lock_value POSTGRES_IMAGE_TAG)"
  sonar_image="$(read_lock_value SONARQUBE_IMAGE)"
  postgres_image="$(read_lock_value POSTGRES_IMAGE)"
  sonar_digest="${sonar_image##*@}"
  postgres_digest="${postgres_image##*@}"
  [ "$sonar_tag" = "$SONAR_TAG" ] || { echo "Unexpected SonarQube tag in lock" >&2; return 1; }
  [ "$postgres_tag" = "$POSTGRES_TAG" ] || { echo "Unexpected PostgreSQL tag in lock" >&2; return 1; }
  [ "$sonar_image" = "sonarqube:$SONAR_TAG@$sonar_digest" ] && validate_digest "$sonar_digest" || {
    echo "SonarQube image is not pinned by digest" >&2
    return 1
  }
  [ "$postgres_image" = "postgres:$POSTGRES_TAG@$postgres_digest" ] && validate_digest "$postgres_digest" || {
    echo "PostgreSQL image is not pinned by digest" >&2
    return 1
  }
  [ "$(grep -Fxc "    image: $sonar_image" "$COMPOSE_FILE")" -eq 1 ] \
    || { echo "SonarQube Compose image differs from the immutable lock" >&2; return 1; }
  [ "$(grep -Fxc "    image: $postgres_image" "$COMPOSE_FILE")" -eq 1 ] \
    || { echo "PostgreSQL Compose image differs from the immutable lock" >&2; return 1; }
}

registry_digest() {
  local repository="$1" tag="$2" token headers digest
  [ -x "$CURL_BIN" ] || { echo "curl is required to resolve image digests" >&2; return 1; }
  [ -x "$NODE_BIN" ] || { echo "node is required to resolve image digests" >&2; return 1; }
  token="$($CURL_BIN --fail --silent --show-error --location \
    "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/$repository:pull" \
    | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);if(!v.token)process.exit(1);process.stdout.write(v.token)})')"
  [ -n "$token" ] || { echo "Docker Hub returned an empty registry token" >&2; return 1; }
  headers="$($CURL_BIN --fail --silent --show-error --head \
    -H "Authorization: Bearer $token" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
    "https://registry-1.docker.io/v2/library/$repository/manifests/$tag")"
  unset token
  digest="$(printf '%s\n' "$headers" | tr -d '\r' | awk -F': ' 'tolower($1) == "docker-content-digest" { print $2; exit }')"
  validate_digest "$digest" || { echo "Registry returned an invalid digest for $repository:$tag" >&2; return 1; }
  printf '%s' "$digest"
}

if [ "$ACTION" = verify ]; then
  verify_lock
  echo "sonar_image_lock_ok mode=offline tags=$SONAR_TAG,$POSTGRES_TAG"
  exit 0
fi

sonar_digest="$(registry_digest sonarqube "$SONAR_TAG")"
postgres_digest="$(registry_digest postgres "$POSTGRES_TAG")"

if [ "$ACTION" = write ]; then
  mkdir -p "$(dirname "$LOCK_FILE")"
  tmp_lock="$(mktemp "$(dirname "$LOCK_FILE")/.images.lock.XXXXXX")"
  tmp_compose="$(mktemp "$(dirname "$COMPOSE_FILE")/.compose.XXXXXX")"
  cleanup() { rm -f "$tmp_lock" "$tmp_compose"; }
  trap cleanup EXIT
  cat >"$tmp_lock" <<EOF
# Generated and verified by scripts/quality-sonar-resolve-images.sh.
# This file contains public image identities only; it is not a secret file.
SONARQUBE_IMAGE_TAG=$SONAR_TAG
SONARQUBE_IMAGE=sonarqube:$SONAR_TAG@$sonar_digest
POSTGRES_IMAGE_TAG=$POSTGRES_TAG
POSTGRES_IMAGE=postgres:$POSTGRES_TAG@$postgres_digest
EOF
  python3 - "$COMPOSE_FILE" "$tmp_compose" \
    "sonarqube:$SONAR_TAG@$sonar_digest" \
    "postgres:$POSTGRES_TAG@$postgres_digest" <<'PY'
from pathlib import Path
import re
import sys

source, target = map(Path, sys.argv[1:3])
sonar, postgres = sys.argv[3:]
body = source.read_text(encoding="utf-8")
body, postgres_count = re.subn(
    r"(?m)^    image: postgres:[^\n]+$", f"    image: {postgres}", body
)
body, sonar_count = re.subn(
    r"(?m)^    image: sonarqube:[^\n]+$", f"    image: {sonar}", body
)
if postgres_count != 1 or sonar_count != 1:
    raise SystemExit("Compose does not contain exactly one pinned image per service")
target.write_text(body, encoding="utf-8")
PY
  chmod 0644 "$tmp_lock"
  chmod 0644 "$tmp_compose"
  mv "$tmp_lock" "$LOCK_FILE"
  mv "$tmp_compose" "$COMPOSE_FILE"
  trap - EXIT
  echo "sonar_image_lock_written path=$LOCK_FILE"
  exit 0
fi

verify_lock
locked_sonar="$(read_lock_value SONARQUBE_IMAGE)"
locked_postgres="$(read_lock_value POSTGRES_IMAGE)"
[ "$locked_sonar" = "sonarqube:$SONAR_TAG@$sonar_digest" ] || {
  echo "SonarQube registry digest drifted; review and run --write explicitly" >&2
  exit 1
}
[ "$locked_postgres" = "postgres:$POSTGRES_TAG@$postgres_digest" ] || {
  echo "PostgreSQL registry digest drifted; review and run --write explicitly" >&2
  exit 1
}
echo "sonar_image_lock_ok mode=registry-verified tags=$SONAR_TAG,$POSTGRES_TAG"
