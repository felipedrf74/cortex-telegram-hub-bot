#!/usr/bin/env bash
# Verify the complete reviewed scanner bundle receipt, launcher digest, runtime
# version, platform, ownership, and permissions before an advisory scan.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
LOCK_FILE="$ROOT/ops/sonarqube/scanner.lock.env"
SCANNER_BIN="${SONAR_SCANNER_BIN:-$(command -v sonar-scanner 2>/dev/null || true)}"

usage() {
  echo "Usage: quality-sonar-verify-scanner.sh --scanner-bin <absolute-sonar-scanner> [--lock-file <exact-origin-main-lock>]"
}
while [ $# -gt 0 ]; do
  case "$1" in
    --scanner-bin) SCANNER_BIN="$2"; shift 2 ;;
    --lock-file) LOCK_FILE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 64 ;;
  esac
done

[ -n "$ROOT" ] || { echo "Scanner verifier must run from the Nexus Hub repository" >&2; exit 1; }
[[ "$LOCK_FILE" == /* ]] && [ -f "$LOCK_FILE" ] && [ ! -L "$LOCK_FILE" ] \
  || { echo "Scanner lock file must be an absolute regular non-symlink file" >&2; exit 1; }
[ "$(realpath "$LOCK_FILE")" = "$LOCK_FILE" ] || { echo "Scanner lock file path must be canonical" >&2; exit 1; }
[[ "$SCANNER_BIN" == /* ]] && [ -f "$SCANNER_BIN" ] && [ ! -L "$SCANNER_BIN" ] && [ -x "$SCANNER_BIN" ] \
  || { echo "Scanner launcher must be an absolute executable regular non-symlink file" >&2; exit 1; }
[ "$(realpath "$SCANNER_BIN")" = "$SCANNER_BIN" ] || { echo "Scanner launcher path must be canonical" >&2; exit 1; }

lock_value() {
  local key="$1" matches
  matches="$(awk -F= -v key="$key" '$1 == key { print substr($0, length(key) + 2) }' "$LOCK_FILE")"
  [ "$(printf '%s\n' "$matches" | awk 'NF { count += 1 } END { print count + 0 }')" -eq 1 ] \
    || { echo "Scanner lock must contain exactly one $key" >&2; return 1; }
  printf '%s' "$matches"
}

version="$(lock_value SONAR_SCANNER_VERSION)"
platform="$(lock_value SONAR_SCANNER_PLATFORM)"
archive_url="$(lock_value SONAR_SCANNER_ARCHIVE_URL)"
archive_sha="$(lock_value SONAR_SCANNER_ARCHIVE_SHA256)"
launcher_sha="$(lock_value SONAR_SCANNER_LAUNCHER_SHA256)"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Invalid locked scanner version" >&2; exit 1; }
[ "$platform" = macosx-aarch64 ] || { echo "Unsupported locked scanner platform" >&2; exit 1; }
[ "$archive_url" = "https://binaries.sonarsource.com/Distribution/sonar-scanner-cli/sonar-scanner-cli-$version-$platform.zip" ] \
  || { echo "Locked scanner URL does not match version and platform" >&2; exit 1; }
[[ "$archive_sha" =~ ^[0-9a-f]{64}$ && "$launcher_sha" =~ ^[0-9a-f]{64}$ ]] \
  || { echo "Scanner lock digests must be full lowercase SHA-256 values" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] \
  || { echo "Pinned scanner is restricted to macOS arm64" >&2; exit 1; }

scanner_owner="$(stat -f '%Su' "$SCANNER_BIN")"
scanner_mode="$(stat -f '%Lp' "$SCANNER_BIN")"
[ "$scanner_owner" = "$(id -un)" ] || { echo "Scanner launcher must be owned by the scanning user" >&2; exit 1; }
[ $((8#$scanner_mode & 8#022)) -eq 0 ] || { echo "Scanner launcher must not be group- or world-writable" >&2; exit 1; }
[ "$(basename "$SCANNER_BIN")" = sonar-scanner ] \
  && [ "$(basename "$(dirname "$SCANNER_BIN")")" = bin ] \
  || { echo "Scanner launcher must remain in the reviewed bundle bin directory" >&2; exit 1; }

bundle_root="$(dirname "$(dirname "$SCANNER_BIN")")"
receipt="$bundle_root/.nexus-archive-sha256"
[ -f "$receipt" ] && [ ! -L "$receipt" ] || { echo "Scanner bundle digest receipt is missing or a symlink" >&2; exit 1; }
[ "$(stat -f '%Su' "$receipt")" = "$(id -un)" ] && [ "$(stat -f '%Lp' "$receipt")" = 600 ] \
  || { echo "Scanner bundle digest receipt must be scanner-user-owned mode 0600" >&2; exit 1; }
[ "$(tr -d '\r\n' <"$receipt")" = "$archive_sha" ] \
  || { echo "Scanner bundle receipt does not match the committed archive digest" >&2; exit 1; }

observed_launcher_sha="$(shasum -a 256 "$SCANNER_BIN" | awk '{ print $1 }')"
[ "$observed_launcher_sha" = "$launcher_sha" ] || { echo "Scanner launcher digest mismatch" >&2; exit 1; }
version_output="$("$SCANNER_BIN" --version 2>&1)"
printf '%s\n' "$version_output" | grep -Fq "SonarScanner CLI $version" \
  || { echo "Scanner runtime version does not match the committed lock" >&2; exit 1; }
printf '%s\n' "$version_output" | grep -Eq 'Mac OS X .* aarch64$' \
  || { echo "Scanner runtime platform does not match the committed lock" >&2; exit 1; }

echo "sonar_scanner_lock_ok version=$version platform=$platform archiveSha256=$archive_sha launcherSha256=$launcher_sha"
