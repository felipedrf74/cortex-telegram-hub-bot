#!/usr/bin/env bash
# Build the exact Ubuntu 24.04/x86-64 production dependency payload once in RC.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PYTHON_BIN="${NEXUS_RELEASE_PYTHON_BIN:-python}"

[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || {
  echo "Release dependencies must be built on Linux x86_64" >&2
  exit 1
}
. /etc/os-release
[ "$ID" = ubuntu ] && [ "$VERSION_ID" = 24.04 ] || {
  echo "Release dependencies must be built on Ubuntu 24.04" >&2
  exit 1
}
[ "$(node --version)" = v22.23.1 ] || { echo "Release dependency Node must be v22.23.1" >&2; exit 1; }
python_version="$($PYTHON_BIN --version)"
[[ "$python_version" =~ ^Python\ 3\.12\.[0-9]+$ ]] || {
  echo "Release dependency Python must be an exact 3.12 patch" >&2
  exit 1
}

rm -rf dist/runtime-dependencies
mkdir -p dist/runtime-dependencies/python-wheelhouse

# The workflow has already completed tests/build from `npm ci`. Prune that
# lockfile-derived tree once, then archive it with normalized metadata so the
# protected-main and RC artifact identities can be compared byte-for-byte.
npm prune --omit=dev --no-audit --no-fund
compression_started_ns="$(date +%s%N)"
tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner \
  -cf - node_modules | gzip -n -6 > dist/runtime-dependencies/node_modules.tar.gz
compression_completed_ns="$(date +%s%N)"
compression_elapsed_ms=$(((compression_completed_ns - compression_started_ns) / 1000000))
node_archive_bytes="$(stat -c '%s' dist/runtime-dependencies/node_modules.tar.gz)"
printf '{"schema":"nexus.release-optimization-telemetry.v1","metric":"node-archive","gzipLevel":6,"elapsedMs":%s,"bytes":%s,"advisory":true}\n' \
  "$compression_elapsed_ms" "$node_archive_bytes"

"$PYTHON_BIN" -m pip download \
  --disable-pip-version-check \
  --only-binary=:all: \
  --dest dist/runtime-dependencies/python-wheelhouse \
  --requirement content-engine/requirements.txt

node scripts/release-runtime-dependencies.mjs write-lock \
  --root "$ROOT" \
  --os ubuntu \
  --os-version 24.04 \
  --architecture x86_64 \
  --node "$(node --version)" \
  --python "$python_version"
