#!/usr/bin/env bash
# Dispatch the existing protected operational signer and atomically install
# one exact, signed rollback-drill freshness artifact.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

usage() {
  echo "Usage: scripts/request-rollback-drill-signature.sh <unsigned-payload.json> [output.json]"
}

[ $# -ge 1 ] && [ $# -le 2 ] || { usage >&2; exit 64; }
REQUEST_INPUT="$1"
OUTPUT_INPUT="${2:-.local/release/rollback-drill-latest.json}"
REQUEST="$(node -e 'process.stdout.write(require("path").resolve(process.argv[1]))' "$REQUEST_INPUT")"
OUTPUT="$(node -e 'process.stdout.write(require("path").resolve(process.argv[1]))' "$OUTPUT_INPUT")"
LOCAL_RELEASE="$ROOT/.local/release"

[ -f "$REQUEST" ] && [ ! -L "$REQUEST" ] || {
  echo "rollback drill request must be a regular non-symlink file" >&2
  exit 64
}
REQUEST_SIZE="$(wc -c < "$REQUEST" | tr -d '[:space:]')"
[[ "$REQUEST_SIZE" =~ ^[0-9]+$ ]] && [ "$REQUEST_SIZE" -gt 0 ] && [ "$REQUEST_SIZE" -le 45000 ] || {
  echo "rollback drill request must be between 1 and 45000 bytes" >&2
  exit 64
}

[ ! -L "$ROOT/.local" ] && [ ! -L "$LOCAL_RELEASE" ] || {
  echo "local release evidence root must not be a symlink" >&2
  exit 64
}
install -d -m 700 "$LOCAL_RELEASE"
OUTPUT_PARENT="$(dirname "$OUTPUT")"
[ -d "$OUTPUT_PARENT" ] && [ ! -L "$OUTPUT_PARENT" ] || {
  echo "signed rollback drill output parent must be an existing non-symlink directory" >&2
  exit 64
}
REAL_LOCAL_RELEASE="$(cd "$LOCAL_RELEASE" && pwd -P)"
REAL_OUTPUT_PARENT="$(cd "$OUTPUT_PARENT" && pwd -P)"
case "$REAL_OUTPUT_PARENT" in
  "$REAL_LOCAL_RELEASE"|"$REAL_LOCAL_RELEASE"/*) ;;
  *)
    echo "signed rollback drill output parent escapes .local/release" >&2
    exit 64
    ;;
esac
if [ -e "$OUTPUT" ] || [ -L "$OUTPUT" ]; then
  [ -f "$OUTPUT" ] && [ ! -L "$OUTPUT" ] || {
    echo "signed rollback drill output must be a regular non-symlink file" >&2
    exit 64
  }
fi

if ! PAYLOAD_VALIDATION="$(node scripts/rollback-drill-check.mjs validate-payload \
  --root "$ROOT" \
  --evidence "$REQUEST" \
  --release-gate \
  --max-age-days 30 \
  --json)"; then
  printf '%s\n' "$PAYLOAD_VALIDATION" >&2
  exit 1
fi
TARGET_SHA="$(printf '%s' "$PAYLOAD_VALIDATION" | node -e '
let body = "";
process.stdin.on("data", (chunk) => { body += chunk; });
process.stdin.on("end", () => {
  const parsed = JSON.parse(body);
  if (parsed.ok !== true || !/^[0-9a-f]{40}$/.test(parsed.evidence?.targetSha ?? "")) process.exit(1);
  process.stdout.write(parsed.evidence.targetSha);
});')"
[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  echo "rollback drill target SHA is invalid" >&2
  exit 64
}
REQUEST_SHA256="$(node -e '
const crypto = require("crypto");
const fs = require("fs");
process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"));
' "$REQUEST")"
REQUEST_B64="$(base64 < "$REQUEST" | tr -d '\r\n')"
[ -n "$REQUEST_B64" ] && [ "${#REQUEST_B64}" -le 60000 ] || {
  echo "base64 rollback drill request is empty or too large" >&2
  exit 64
}
REQUEST_ID="$(node -e 'process.stdout.write(require("crypto").randomUUID())')"

command -v gh >/dev/null 2>&1 || { echo "GitHub CLI is required to request rollback signing" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "GitHub CLI authentication is required" >&2; exit 1; }

REF="main"
SIGNING_WORKFLOW="sign-staging-attestation.yml"
gh workflow view "$SIGNING_WORKFLOW" --ref "$REF" --yaml >/dev/null 2>&1 || {
  echo "protected-main operational signing workflow is unavailable" >&2
  exit 1
}
gh workflow run "$SIGNING_WORKFLOW" --ref "$REF" \
  -f "evidence_kind=rollback_drill" \
  -f "request_id=$REQUEST_ID" \
  -f "runtime_sha=$TARGET_SHA" \
  -f "request_sha256=$REQUEST_SHA256" \
  -f "request_b64=$REQUEST_B64"

TITLE="Sign rollback_drill $REQUEST_ID digest $REQUEST_SHA256"
RUN_ID=""
for _ in $(seq 1 30); do
  RUNS="$(gh run list --workflow "$SIGNING_WORKFLOW" --limit 30 \
    --json databaseId,displayTitle)"
  MATCHES="$(printf '%s' "$RUNS" | node -e '
let body = "";
process.stdin.on("data", (chunk) => { body += chunk; });
process.stdin.on("end", () => {
  const runs = JSON.parse(body);
  const title = process.argv[1];
  const ids = runs
    .filter((run) => run?.displayTitle === title && /^[0-9]+$/.test(String(run?.databaseId ?? "")))
    .map((run) => String(run.databaseId));
  process.stdout.write(ids.join("\n"));
});' "$TITLE")"
  if [ -n "$MATCHES" ]; then
    RUN_ID="$(printf '%s\n' "$MATCHES" | sed -n '1p')"
    SECOND_MATCH="$(printf '%s\n' "$MATCHES" | sed -n '2p')"
    [ -z "$SECOND_MATCH" ] || {
      echo "rollback signing workflow correlation is ambiguous" >&2
      exit 1
    }
    break
  fi
  sleep 2
done
[[ "$RUN_ID" =~ ^[0-9]+$ ]] || {
  echo "rollback signing workflow run was not found" >&2
  exit 1
}
gh run watch "$RUN_ID" --exit-status

DOWNLOAD="$(mktemp -d "$LOCAL_RELEASE/rollback-signing-download.XXXXXX")"
TEMP_OUTPUT=""
cleanup() {
  [ -z "$TEMP_OUTPUT" ] || rm -f "$TEMP_OUTPUT"
  rm -rf "$DOWNLOAD"
}
trap cleanup EXIT
gh run download "$RUN_ID" \
  --name "rollback-drill-$REQUEST_ID" \
  --dir "$DOWNLOAD"
SIGNED_COUNT="$(find "$DOWNLOAD" -type f -name rollback-drill.json -print | wc -l | tr -d '[:space:]')"
[ "$SIGNED_COUNT" = "1" ] || {
  echo "signed rollback drill artifact count is invalid" >&2
  exit 1
}
SIGNED="$(find "$DOWNLOAD" -type f -name rollback-drill.json -print -quit)"
[ -f "$SIGNED" ] && [ ! -L "$SIGNED" ] || {
  echo "signed rollback drill artifact is missing or unsafe" >&2
  exit 1
}
node scripts/rollback-drill-check.mjs validate \
  --root "$ROOT" \
  --evidence "$SIGNED" \
  --public-key "$ROOT/docs/release/evidence/release-evidence-public-key.pem" \
  --expect-sha "$TARGET_SHA" \
  --release-gate \
  --max-age-days 30 \
  --json >/dev/null
node - "$REQUEST" "$SIGNED" <<'NODE'
const fs = require('fs');
const [requestFile, signedFile] = process.argv.slice(2);
const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
const signed = JSON.parse(fs.readFileSync(signedFile, 'utf8'));
const canonical = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
};
if (canonical(request) !== canonical(signed.payload)) {
  throw new Error('downloaded rollback drill payload differs from the exact reviewed request');
}
NODE

TEMP_OUTPUT="$(mktemp "$OUTPUT_PARENT/.rollback-drill.next.XXXXXX")"
install -m 600 "$SIGNED" "$TEMP_OUTPUT"
mv -f "$TEMP_OUTPUT" "$OUTPUT"
TEMP_OUTPUT=""
chmod 600 "$OUTPUT"
[ -f "$OUTPUT" ] && [ ! -L "$OUTPUT" ] || {
  echo "signed rollback drill output installation is unsafe" >&2
  exit 1
}
OUTPUT_MODE="$(stat -c '%a' "$OUTPUT" 2>/dev/null || stat -f '%Lp' "$OUTPUT")"
[ "$OUTPUT_MODE" = 600 ] || {
  echo "signed rollback drill output mode is not 600" >&2
  exit 1
}
printf '{"ok":true,"requestId":"%s","workflowRunId":"%s","targetSha":"%s","requestSha256":"%s","evidence":"%s"}\n' \
  "$REQUEST_ID" "$RUN_ID" "$TARGET_SHA" "$REQUEST_SHA256" "$OUTPUT"
