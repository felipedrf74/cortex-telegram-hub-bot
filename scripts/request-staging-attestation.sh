#!/usr/bin/env bash
# Dispatch the owner-only GitHub signer and download its detached attestation.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
REQUEST="${1:?staging request path is required}"
MANIFEST="${2:?release manifest path is required}"
OUTPUT="${3:?signed staging attestation output path is required}"

command -v gh >/dev/null 2>&1 || { echo "GitHub CLI is required to request staging signing" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "GitHub CLI authentication is required" >&2; exit 1; }

read_request_field() {
  node -e 'const x=require(process.argv[1]);const v=x[process.argv[2]];if(v==null)process.exit(2);process.stdout.write(String(v));' "$REQUEST" "$1"
}

REQUEST_ID="$(read_request_field requestId)"
RUNTIME_SHA="$(read_request_field runtimeSha)"
[[ "$REQUEST_ID" =~ ^[0-9a-f-]{36}$ ]] || { echo "invalid staging request id" >&2; exit 1; }
[[ "$RUNTIME_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid staging runtime SHA" >&2; exit 1; }
node scripts/release-staging-attestation.mjs validate-request \
  --request "$REQUEST" --expect-runtime-sha "$RUNTIME_SHA" >/dev/null

REF="main"
REQUEST_B64="$(base64 < "$REQUEST" | tr -d '\r\n')"
SIGNING_WORKFLOW="sign-staging-attestation.yml"
gh workflow view "$SIGNING_WORKFLOW" --ref "$REF" >/dev/null 2>&1 || {
  echo "protected-main staging signing workflow is unavailable" >&2
  exit 1
}
gh workflow run "$SIGNING_WORKFLOW" --ref "$REF" \
  -f "request_id=$REQUEST_ID" \
  -f "runtime_sha=$RUNTIME_SHA" \
  -f "request_b64=$REQUEST_B64"

RUN_ID=""
for _ in $(seq 1 30); do
  RUN_ID="$(gh run list --workflow "$SIGNING_WORKFLOW" --limit 30 \
    --json databaseId,displayTitle \
    --jq ".[] | select(.displayTitle == \"Sign staging attestation $REQUEST_ID\") | .databaseId" \
    | head -1)"
  [ -z "$RUN_ID" ] || break
  sleep 2
done
[ -n "$RUN_ID" ] || { echo "staging signing workflow run was not found" >&2; exit 1; }
gh run watch "$RUN_ID" --exit-status

DOWNLOAD=".local/release/staging/download-$REQUEST_ID"
rm -rf "$DOWNLOAD"
mkdir -p "$DOWNLOAD" "$(dirname "$OUTPUT")"
gh run download "$RUN_ID" --name "staging-attestation-$REQUEST_ID" --dir "$DOWNLOAD"
SIGNED="$(find "$DOWNLOAD" -type f -name staging-attestation.json -print -quit)"
[ -n "$SIGNED" ] || { echo "signed staging attestation artifact is missing" >&2; exit 1; }
mv "$SIGNED" "$OUTPUT"
rm -rf "$DOWNLOAD"
node scripts/release-staging-attestation.mjs validate \
  --attestation "$OUTPUT" --manifest "$MANIFEST" --expect-runtime-sha "$RUNTIME_SHA"
