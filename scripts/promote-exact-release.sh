#!/usr/bin/env bash
# Submit one durable, user-owned production transaction and poll its result.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/lib/release-gates.sh"
SERVER="${1:?server is required}"
SOURCE_BUNDLE="${2:?remote source bundle is required}"
RUNTIME_SHA="${3:?runtime SHA is required}"
ARTIFACT_DIGEST="${4:?artifact digest is required}"
TRANSACTION_ID="${5:?transaction ID is required}"
MANIFEST="${6:?release manifest is required}"
MANIFEST_SHA256="${7:?release manifest digest is required}"
EXPECTED_PREDECESSOR_DIGEST="${8:?expected predecessor digest is required}"
STABILITY_SECONDS="${NEXUS_RELEASE_PRODUCTION_STABILITY_SECONDS:-60}"
UNIT="nexus-release-production-${RUNTIME_SHA:0:12}"
REMOTE_SCRIPT="$SOURCE_BUNDLE/scripts/remote-user-release-transaction.sh"

[[ "$SERVER" =~ ^[A-Za-z0-9._@-]+$ ]] || { echo "invalid deploy server" >&2; exit 64; }
[[ "$SOURCE_BUNDLE" == /home/dominguez/.local/share/nexus-release/incoming/* ]] \
  || { echo "invalid remote source bundle" >&2; exit 64; }
[[ "$RUNTIME_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid runtime SHA" >&2; exit 64; }
[[ "$ARTIFACT_DIGEST" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid artifact digest" >&2; exit 64; }
[[ "$MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid release manifest digest" >&2; exit 64; }
[[ "$EXPECTED_PREDECESSOR_DIGEST" =~ ^[0-9a-f]{64}$ ]] \
  || { echo "invalid expected predecessor digest" >&2; exit 64; }
[[ "$TRANSACTION_ID" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$ ]] || {
  echo "invalid transaction ID" >&2
  exit 64
}

# Independently validate the exact manifest and run the same non-bypassable
# conditional chat preflight before any SSH for a new production transaction.
MANIFEST_PREFLIGHT="$(
  node --no-warnings "$ROOT/scripts/release-checksum-manifest.mjs" preflight-chat \
    --manifest "$MANIFEST" \
    --expect-manifest-sha256 "$MANIFEST_SHA256" \
    --expect-source-sha "$RUNTIME_SHA" \
    --expect-artifact-digest "$ARTIFACT_DIGEST"
)"
EXPECTED_PREDECESSOR_SHA="$(
  node -e '
const value=JSON.parse(process.argv[1]);
const sha=value?.releaseImpact?.deployedSha;
if(!/^[0-9a-f]{40}$/.test(sha||""))process.exit(1);
process.stdout.write(sha);' "$MANIFEST_PREFLIGHT"
)"
node - "$ROOT/docs/release/release-state.json" \
  "$EXPECTED_PREDECESSOR_SHA" "$EXPECTED_PREDECESSOR_DIGEST" <<'NODE'
const fs = require('node:fs');
const [file, expectedSha, expectedDigest] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
if (value?.backend?.runtimeSha !== expectedSha
    || value?.backend?.artifactDigest !== expectedDigest) {
  process.exit(1);
}
NODE

release_reassert_exact_protected_main "$ROOT" "$RUNTIME_SHA"
ssh "$SERVER" systemd-run --user --quiet --collect \
  --unit "$UNIT" \
  --property Type=oneshot \
  --property TimeoutStartSec=8min \
  /bin/bash "$REMOTE_SCRIPT" promote /home/dominguez/telegram-hub-bot \
  "$SOURCE_BUNDLE" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$TRANSACTION_ID" \
  "$STABILITY_SECONDS" "$EXPECTED_PREDECESSOR_SHA" "$EXPECTED_PREDECESSOR_DIGEST"

deadline=$((SECONDS + 600))
while [ "$SECONDS" -lt "$deadline" ]; do
  state="$(ssh "$SERVER" cat /home/dominguez/.local/state/nexus-release/production.json 2>/dev/null || true)"
  if [ -n "$state" ]; then
    set +e
    printf '%s' "$state" | node -e '
let body="";process.stdin.on("data",chunk=>body+=chunk);process.stdin.on("end",()=>{
 const x=JSON.parse(body),[id,sha,digest,predecessorSha,predecessorDigest]=process.argv.slice(1);
 if(x.schema!=="nexus.lean-release-transaction.v1"||x.role!=="production"
   ||x.transactionId!==id||x.runtimeSha!==sha||x.artifactDigest!==digest)process.exit(3);
 if(x.status==="passed"&&x.phase==="completed"){
   if(x.predecessorSha!==predecessorSha
     ||x.predecessorDigest!==predecessorDigest)process.exit(2);
   process.exit(0);
 }
 if(x.status==="failed")process.exit(2);
 process.exit(4);
});' "$TRANSACTION_ID" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" \
      "$EXPECTED_PREDECESSOR_SHA" "$EXPECTED_PREDECESSOR_DIGEST"
    state_status=$?
    set -e
    case "$state_status" in
      0) printf '%s\n' "$state"; exit 0 ;;
      2)
        printf '%s\n' "$state" >&2
        ssh "$SERVER" journalctl --user -u "$UNIT" --no-pager -n 120 >&2 || true
        exit 1
        ;;
      3|4) ;;
      *) echo "invalid production transaction state" >&2; exit 1 ;;
    esac
  fi
  sleep 2
done
echo "production transaction did not finish within ten minutes" >&2
exit 75
