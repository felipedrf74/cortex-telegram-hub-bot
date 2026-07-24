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
REQUEST_ID=""
RUN_ID=""
DISPATCH_ONLY=false
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
    --request-id) REQUEST_ID="$2"; shift 2 ;;
    --run-id) RUN_ID="$2"; shift 2 ;;
    --dispatch-only) DISPATCH_ONLY=true; shift ;;
    -h|--help)
      echo "Usage: scripts/request-release-manifest-signature.sh <sha> <rc-run-id> [install-root] (--backend-only | --includes-ios --ios-attestation <signed-json> --ios-distribution-attestation <signed-json>) [--request-id <uuid>] [--run-id <id> | --dispatch-only]"
      exit 0
      ;;
    *) echo "Unknown argument: $1" >&2; exit 64 ;;
  esac
done

[[ "$RUNTIME_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid runtime SHA" >&2; exit 64; }
[[ "$CANDIDATE_RUN_ID" =~ ^[0-9]+$ ]] || { echo "invalid candidate run ID" >&2; exit 64; }
if [ -z "$REQUEST_ID" ]; then
  REQUEST_ID="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
fi
[[ "$REQUEST_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
  || { echo "invalid release signing request id" >&2; exit 64; }
[[ -z "$RUN_ID" || "$RUN_ID" =~ ^[1-9][0-9]*$ ]] || { echo "invalid release signing run id" >&2; exit 64; }
[ "$DISPATCH_ONLY" = false ] || [ -z "$RUN_ID" ] || {
  echo "--dispatch-only and --run-id are mutually exclusive" >&2
  exit 64
}
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
TITLE="Sign release candidate $RUNTIME_SHA run $CANDIDATE_RUN_ID request $REQUEST_ID"
if [ -z "$RUN_ID" ]; then
  gh workflow run "$WORKFLOW" --ref main \
    -f "runtime_sha=$RUNTIME_SHA" \
    -f "candidate_run_id=$CANDIDATE_RUN_ID" \
    -f "request_id=$REQUEST_ID" \
    "${CONTRACT_INPUTS[@]}"
  if [ "$DISPATCH_ONLY" = true ]; then
    printf '{"ok":true,"dispatched":true,"requestId":"%s","runtimeSha":"%s"}\n' \
      "$REQUEST_ID" "$RUNTIME_SHA"
    exit 0
  fi
  for _ in $(seq 1 30); do
    RUN_ID="$(EXPECTED_TITLE="$TITLE" EXPECTED_SHA="$RUNTIME_SHA" \
      gh run list --workflow "$WORKFLOW" --branch main --event workflow_dispatch --limit 50 \
        --json databaseId,displayTitle,headSha,headBranch,event,createdAt \
      | node -e '
        let body="";process.stdin.on("data",c=>body+=c);process.stdin.on("end",()=>{
          const rows=JSON.parse(body).filter((row)=>row.displayTitle===process.env.EXPECTED_TITLE
            &&row.headSha===process.env.EXPECTED_SHA&&row.headBranch==="main"
            &&row.event==="workflow_dispatch");
          if(rows.length>1)process.exit(65);
          if(rows.length===1)process.stdout.write(String(rows[0].databaseId));
        });'
    )" || { echo "release signing workflow correlation is ambiguous" >&2; exit 65; }
    [ -z "$RUN_ID" ] || break
    sleep 2
  done
fi
[ -n "$RUN_ID" ] || { echo "release signing workflow run was not found" >&2; exit 1; }

validate_run_identity() {
  local require_complete="$1"
  gh run view "$RUN_ID" --json \
    databaseId,displayTitle,headSha,headBranch,event,status,conclusion,workflowName \
    | node -e '
      let body="";process.stdin.on("data",c=>body+=c);process.stdin.on("end",()=>{
        const x=JSON.parse(body),[id,title,sha,complete]=process.argv.slice(1);
        if(String(x.databaseId)!==id||x.displayTitle!==title||x.headSha!==sha
          ||x.headBranch!=="main"||x.event!=="workflow_dispatch"
          ||x.workflowName!=="Release — Sign exact candidate")process.exit(1);
        if(complete==="1"&&(x.status!=="completed"||x.conclusion!=="success"))process.exit(1);
      });' "$RUN_ID" "$TITLE" "$RUNTIME_SHA" "$require_complete"
}
validate_run_identity 0 || { echo "release signing run identity is invalid" >&2; exit 1; }
gh run watch "$RUN_ID" --exit-status
validate_run_identity 1 || { echo "completed release signing run identity is invalid" >&2; exit 1; }

INSTALL_ROOT="$(cd "$INSTALL_ROOT" && pwd)"
INSTALL_RELEASE="$INSTALL_ROOT/.local/release"
install -d -m 700 "$INSTALL_ROOT/.local" "$INSTALL_RELEASE"
DOWNLOAD="$(mktemp -d "$INSTALL_RELEASE/.signing-download-${REQUEST_ID}.XXXXXX")"
cleanup_download() {
  case "$DOWNLOAD" in "$INSTALL_RELEASE"/.signing-download-"$REQUEST_ID".*) rm -rf "$DOWNLOAD" ;; esac
}
trap cleanup_download EXIT
gh run download "$RUN_ID" \
  --name "release-manifest-v2-$RUNTIME_SHA" \
  --dir "$DOWNLOAD"
MANIFESTS="$(find "$DOWNLOAD" -type f -path "*/.local/release/manifests/$RUNTIME_SHA.json" -print)"
[ "$(printf '%s\n' "$MANIFESTS" | sed '/^$/d' | wc -l | tr -d ' ')" = 1 ] \
  || { echo "signed ReleaseManifestV2 is missing or ambiguous" >&2; exit 1; }
MANIFEST="$MANIFESTS"
TIMINGS="$(find "$DOWNLOAD" -type f -path "*/.local/release/timing/$RUNTIME_SHA.json" -print)"
TIMING_COUNT="$(printf '%s\n' "$TIMINGS" | sed '/^$/d' | wc -l | tr -d ' ')"
case "$TIMING_COUNT" in
  0)
    TIMING=""
    echo "signed protected release timing is unavailable; release timing remains advisory" >&2
    ;;
  1) TIMING="$TIMINGS" ;;
  *) echo "signed protected release timing evidence is ambiguous" >&2; exit 1 ;;
esac
BUNDLE_MARKERS="$(find "$DOWNLOAD" -type f -path "*/.local/release/bundles/$RUNTIME_SHA/*/.complete.json" -print)"
[ "$(printf '%s\n' "$BUNDLE_MARKERS" | sed '/^$/d' | wc -l | tr -d ' ')" = 1 ] \
  || { echo "signed release artifact bundle is missing or ambiguous" >&2; exit 1; }
BUNDLE="$(dirname "$BUNDLE_MARKERS")"
node scripts/release-manifest-v2.mjs validate \
  --manifest "$MANIFEST" \
  --root "$BUNDLE" \
  --verify-bundle \
  --public-key "$ROOT/docs/release/evidence/release-evidence-public-key.pem" \
  --expect-runtime-sha "$RUNTIME_SHA" \
  "${MANIFEST_EXPECTATIONS[@]}"

ARTIFACT_DIGEST="$(node -e 'process.stdout.write(require(process.argv[1]).payload.artifact.digest)' "$MANIFEST")"
[[ "$ARTIFACT_DIGEST" =~ ^[0-9a-f]{64}$ ]] || { echo "signed artifact digest is invalid" >&2; exit 1; }
DESTINATION_BUNDLE_PARENT="$INSTALL_RELEASE/bundles/$RUNTIME_SHA"
DESTINATION_BUNDLE="$DESTINATION_BUNDLE_PARENT/$ARTIFACT_DIGEST"
install -d -m 700 "$INSTALL_RELEASE/manifests" "$INSTALL_RELEASE/timing" \
  "$INSTALL_RELEASE/bundles" "$DESTINATION_BUNDLE_PARENT"
if [ -e "$DESTINATION_BUNDLE" ] || [ -L "$DESTINATION_BUNDLE" ]; then
  [ -d "$DESTINATION_BUNDLE" ] && [ ! -L "$DESTINATION_BUNDLE" ] || {
    echo "existing release bundle destination is unsafe" >&2
    exit 1
  }
  node scripts/release-manifest-v2.mjs validate \
    --manifest "$MANIFEST" \
    --root "$DESTINATION_BUNDLE" \
    --verify-bundle \
    --public-key "$ROOT/docs/release/evidence/release-evidence-public-key.pem" \
    --expect-runtime-sha "$RUNTIME_SHA" \
    "${MANIFEST_EXPECTATIONS[@]}" >/dev/null
else
  mv "$BUNDLE" "$DESTINATION_BUNDLE"
fi
node - "$MANIFEST" "$INSTALL_RELEASE/manifests/$RUNTIME_SHA.json" \
  "$DESTINATION_BUNDLE_PARENT" "$INSTALL_RELEASE/manifests" <<'NODE'
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const [source,destination,...directories]=process.argv.slice(2);
const sourceStat=fs.lstatSync(source);
if(!sourceStat.isFile()||sourceStat.isSymbolicLink()||sourceStat.size<=0
  ||sourceStat.size>16*1024*1024)throw new Error('downloaded manifest is unsafe');
const body=fs.readFileSync(source);
const parent=path.dirname(destination);
for(const directory of [parent,...directories]){
  const stat=fs.lstatSync(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('release evidence directory is unsafe');
}
const fsyncDirectory=(directory)=>{
  const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
};
if(fs.existsSync(destination)||fs.lstatSync(parent).isSymbolicLink()){
  const stat=fs.lstatSync(destination);
  if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o600
    ||stat.nlink!==1||!fs.readFileSync(destination).equals(body)){
    throw new Error('existing signed manifest differs from the exact signer artifact');
  }
}else{
  const temporary=path.join(parent,`.${path.basename(destination)}.next.${process.pid}.${crypto.randomBytes(8).toString('hex')}`);
  let fd;
  try{
    fd=fs.openSync(temporary,'wx',0o600);
    fs.writeFileSync(fd,body);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    fs.linkSync(temporary,destination);fsyncDirectory(parent);
    fs.unlinkSync(temporary);fsyncDirectory(parent);
  }finally{
    if(fd!==undefined)fs.closeSync(fd);
    try{fs.unlinkSync(temporary);}catch(error){if(error?.code!=='ENOENT')throw error;}
  }
}
for(const directory of directories)fsyncDirectory(directory);
NODE
node scripts/release-manifest-v2.mjs validate \
  --manifest "$INSTALL_RELEASE/manifests/$RUNTIME_SHA.json" \
  --root "$DESTINATION_BUNDLE" \
  --verify-bundle \
  --public-key "$ROOT/docs/release/evidence/release-evidence-public-key.pem" \
  --expect-runtime-sha "$RUNTIME_SHA" \
  "${MANIFEST_EXPECTATIONS[@]}" >/dev/null
if [ -n "$TIMING" ]; then
  TIMING_DESTINATION="$INSTALL_RELEASE/timing/$RUNTIME_SHA.json"
  if [ -e "$TIMING_DESTINATION" ] || [ -L "$TIMING_DESTINATION" ]; then
    node - "$TIMING" "$TIMING_DESTINATION" <<'NODE' || {
const fs=require('node:fs');const [source,destination]=process.argv.slice(2);
const stat=fs.lstatSync(destination);
if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1
 ||(stat.mode&0o777)!==0o600
 ||!fs.readFileSync(source).equals(fs.readFileSync(destination)))process.exit(1);
NODE
      echo "existing protected release timing evidence differs from the signer artifact" >&2
      exit 1
    }
  else
    install -m 600 "$TIMING" "$TIMING_DESTINATION"
  fi
fi
printf '{"ok":true,"runtimeSha":"%s","requestId":"%s","runId":"%s","manifest":"%s"}\n' \
  "$RUNTIME_SHA" "$REQUEST_ID" "$RUN_ID" "$INSTALL_RELEASE/manifests/$RUNTIME_SHA.json"
