#!/usr/bin/env bash
# Dispatch protected-main exact-candidate signing and download its signed artifact.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
RUNTIME_SHA="${1:?exact runtime SHA is required}"
CANDIDATE_RUN_ID="${2:?successful RC workflow run ID is required}"
shift 2
INSTALL_ROOT="$ROOT"
if [ $# -gt 0 ] && [[ "$1" != --* ]]; then
  INSTALL_ROOT="$1"
  shift
fi
CONTRACT_SCOPE=""
IOS_ATTESTATION=""
IOS_DISTRIBUTION_ATTESTATION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --backend-only)
      [ -z "$CONTRACT_SCOPE" ] || { echo "release contract scope may be specified only once" >&2; exit 64; }
      CONTRACT_SCOPE="backend_only"
      shift
      ;;
    --includes-ios)
      [ -z "$CONTRACT_SCOPE" ] || { echo "release contract scope may be specified only once" >&2; exit 64; }
      CONTRACT_SCOPE="shared_backend_ios"
      shift
      ;;
    --ios-attestation) IOS_ATTESTATION="$2"; shift 2 ;;
    --ios-distribution-attestation) IOS_DISTRIBUTION_ATTESTATION="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: scripts/request-release-manifest-signature.sh <sha> <rc-run-id> [install-root] (--backend-only | --includes-ios --ios-attestation <signed-json> --ios-distribution-attestation <signed-json>)"
      exit 0
      ;;
    *) echo "Unknown argument: $1" >&2; exit 64 ;;
  esac
done

[[ "$RUNTIME_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid runtime SHA" >&2; exit 64; }
[[ "$CANDIDATE_RUN_ID" =~ ^[0-9]+$ ]] || { echo "invalid candidate run ID" >&2; exit 64; }
CONTRACT_INPUTS=()
MANIFEST_EXPECTATIONS=()
case "$CONTRACT_SCOPE" in
  backend_only)
    [ -z "$IOS_ATTESTATION" ] && [ -z "$IOS_DISTRIBUTION_ATTESTATION" ] || {
      echo "backend-only release must not include iOS evidence" >&2
      exit 64
    }
    CONTRACT_INPUTS=(-f "contract_scope=backend_only")
    MANIFEST_EXPECTATIONS=(--expect-backend-only)
    ;;
  shared_backend_ios)
    [ -f "$IOS_ATTESTATION" ] || { echo "signed iOS attestation file is required" >&2; exit 64; }
    IOS_ATTESTATION_BASE64="$(base64 < "$IOS_ATTESTATION" | tr -d '\n')"
    [ -n "$IOS_ATTESTATION_BASE64" ] && [ "${#IOS_ATTESTATION_BASE64}" -le 32768 ] || {
      echo "signed iOS attestation is empty or too large" >&2
      exit 64
    }
    [ -f "$IOS_DISTRIBUTION_ATTESTATION" ] || {
      echo "signed iOS distribution attestation file is required" >&2
      exit 64
    }
    IOS_DISTRIBUTION_ATTESTATION_BASE64="$(base64 < "$IOS_DISTRIBUTION_ATTESTATION" | tr -d '\n')"
    [ -n "$IOS_DISTRIBUTION_ATTESTATION_BASE64" ] \
      && [ "${#IOS_DISTRIBUTION_ATTESTATION_BASE64}" -le 131072 ] || {
      echo "signed iOS distribution attestation is empty or too large" >&2
      exit 64
    }
    CONTRACT_INPUTS=(
      -f "contract_scope=shared_backend_ios"
      -f "ios_attestation_base64=$IOS_ATTESTATION_BASE64"
      -f "ios_distribution_attestation_base64=$IOS_DISTRIBUTION_ATTESTATION_BASE64"
    )
    MANIFEST_EXPECTATIONS=(--require-ios-contract)
    ;;
  *)
    echo "explicit --backend-only or --includes-ios contract scope is required" >&2
    exit 64
    ;;
esac
command -v gh >/dev/null 2>&1 || { echo "GitHub CLI is required to request release signing" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "GitHub CLI authentication is required" >&2; exit 1; }

WORKFLOW="sign-release-manifest.yml"
gh workflow view "$WORKFLOW" --ref main --yaml >/dev/null 2>&1 || {
  echo "protected-main release signing workflow is unavailable" >&2
  exit 1
}
gh workflow run "$WORKFLOW" --ref main \
  -f "runtime_sha=$RUNTIME_SHA" \
  -f "candidate_run_id=$CANDIDATE_RUN_ID" \
  "${CONTRACT_INPUTS[@]}"

TITLE="Sign release candidate $RUNTIME_SHA run $CANDIDATE_RUN_ID"
RUN_ID=""
for _ in $(seq 1 30); do
  RUN_ID="$(gh run list --workflow "$WORKFLOW" --limit 30 \
    --json databaseId,displayTitle \
    --jq ".[] | select(.displayTitle == \"$TITLE\") | .databaseId" \
    | head -1)"
  [ -z "$RUN_ID" ] || break
  sleep 2
done
[ -n "$RUN_ID" ] || { echo "release signing workflow run was not found" >&2; exit 1; }
gh run watch "$RUN_ID" --exit-status

DOWNLOAD="$ROOT/.local/release/signing-download-$RUN_ID"
rm -rf "$DOWNLOAD"
mkdir -p "$DOWNLOAD"
gh run download "$RUN_ID" \
  --name "release-manifest-v2-$RUNTIME_SHA" \
  --dir "$DOWNLOAD"
MANIFEST="$(find "$DOWNLOAD" -type f -path "*/.local/release/manifests/$RUNTIME_SHA.json" -print -quit)"
[ -n "$MANIFEST" ] || { echo "signed ReleaseManifestV2 is missing" >&2; exit 1; }
BUNDLE="$(find "$DOWNLOAD" -type f -path "*/.local/release/bundles/$RUNTIME_SHA/*/.complete.json" -print -quit)"
[ -n "$BUNDLE" ] || { echo "signed release artifact bundle is missing" >&2; exit 1; }
BUNDLE="$(dirname "$BUNDLE")"
node scripts/release-manifest-v2.mjs validate \
  --manifest "$MANIFEST" \
  --root "$BUNDLE" \
  --verify-bundle \
  --public-key "$ROOT/docs/release/evidence/release-evidence-public-key.pem" \
  --expect-runtime-sha "$RUNTIME_SHA" \
  "${MANIFEST_EXPECTATIONS[@]}"

mkdir -p "$INSTALL_ROOT/.local/release"
cp -R "$DOWNLOAD/.local/release/." "$INSTALL_ROOT/.local/release/"
rm -rf "$DOWNLOAD"
printf '{"ok":true,"runtimeSha":"%s","manifest":"%s"}\n' \
  "$RUNTIME_SHA" "$INSTALL_ROOT/.local/release/manifests/$RUNTIME_SHA.json"
