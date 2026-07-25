#!/usr/bin/env bash
# Dispatch the owner-only GitHub signer and download its detached attestation.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
REQUEST="${1:?staging request path is required}"
MANIFEST="${2:?release manifest path is required}"
OUTPUT="${3:?signed staging attestation output path is required}"
shift 3
RUN_ID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --run-id) RUN_ID="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: scripts/request-staging-attestation.sh <request> <manifest> <output> [--run-id <exact-workflow-run-id>]"
      exit 0
      ;;
    *) echo "Unknown argument: $1" >&2; exit 64 ;;
  esac
done
[[ -z "$RUN_ID" || "$RUN_ID" =~ ^[1-9][0-9]*$ ]] \
  || { echo "invalid staging signing run id" >&2; exit 64; }

command -v gh >/dev/null 2>&1 || { echo "GitHub CLI is required to request staging signing" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "GitHub CLI authentication is required" >&2; exit 1; }

read_request_field() {
  node -e 'const x=require(process.argv[1]);const v=x[process.argv[2]];if(v==null)process.exit(2);process.stdout.write(String(v));' "$REQUEST" "$1"
}

REQUEST_ID="$(read_request_field requestId)"
RUNTIME_SHA="$(read_request_field runtimeSha)"
INSTALLED_RUNTIME_DIGEST="$(read_request_field installedRuntimeDigest)"
RECOVERY_RUNTIME_DIGEST="$(read_request_field recoveryRuntimeDigest)"
[[ "$REQUEST_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
  || { echo "invalid staging request id" >&2; exit 1; }
[[ "$RUNTIME_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid staging runtime SHA" >&2; exit 1; }
[[ "$INSTALLED_RUNTIME_DIGEST" =~ ^[0-9a-f]{64}$ ]] \
  || { echo "invalid staging installed-runtime digest" >&2; exit 1; }
[[ "$RECOVERY_RUNTIME_DIGEST" =~ ^[0-9a-f]{64}$ ]] \
  || { echo "invalid staging recovery-runtime digest" >&2; exit 1; }
node scripts/release-staging-attestation.mjs validate-request \
  --request "$REQUEST" --expect-runtime-sha "$RUNTIME_SHA" >/dev/null

REF="main"
REQUEST_B64="$(base64 < "$REQUEST" | tr -d '\r\n')"
REQUEST_SHA256="$(node -e 'const c=require("node:crypto"),f=require("node:fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$REQUEST")"
SIGNING_WORKFLOW="sign-staging-attestation.yml"
gh workflow view "$SIGNING_WORKFLOW" --ref "$REF" --yaml >/dev/null 2>&1 || {
  echo "protected-main staging signing workflow is unavailable" >&2
  exit 1
}
TITLE="Sign staging_attestation $REQUEST_ID digest $REQUEST_SHA256"
if [ -z "$RUN_ID" ]; then
  gh workflow run "$SIGNING_WORKFLOW" --ref "$REF" \
    -f "evidence_kind=staging_attestation" \
    -f "request_id=$REQUEST_ID" \
    -f "runtime_sha=$RUNTIME_SHA" \
    -f "request_sha256=$REQUEST_SHA256" \
    -f "request_b64=$REQUEST_B64"
  for _ in $(seq 1 30); do
    RUN_ID="$(EXPECTED_TITLE="$TITLE" EXPECTED_SHA="$RUNTIME_SHA" \
      gh run list --workflow "$SIGNING_WORKFLOW" --branch main --event workflow_dispatch --limit 50 \
        --json databaseId,displayTitle,headSha,headBranch,event,createdAt \
      | node -e '
        let body="";process.stdin.on("data",c=>body+=c);process.stdin.on("end",()=>{
          const rows=JSON.parse(body).filter((row)=>row.displayTitle===process.env.EXPECTED_TITLE
            &&row.headSha===process.env.EXPECTED_SHA&&row.headBranch==="main"
            &&row.event==="workflow_dispatch");
          if(rows.length>1)process.exit(65);
          if(rows.length===1)process.stdout.write(String(rows[0].databaseId));
        });'
    )" || { echo "staging signing workflow correlation is ambiguous" >&2; exit 65; }
    [ -z "$RUN_ID" ] || break
    sleep 2
  done
fi
[ -n "$RUN_ID" ] || { echo "staging signing workflow run was not found" >&2; exit 1; }

validate_run_identity() {
  local require_complete="$1"
  gh run view "$RUN_ID" --json \
    databaseId,displayTitle,headSha,headBranch,event,status,conclusion,workflowName \
    | node -e '
      let body="";process.stdin.on("data",c=>body+=c);process.stdin.on("end",()=>{
        const x=JSON.parse(body),[id,title,sha,complete]=process.argv.slice(1);
        if(String(x.databaseId)!==id||x.displayTitle!==title||x.headSha!==sha
          ||x.headBranch!=="main"||x.event!=="workflow_dispatch"
          ||x.workflowName!=="Release — Sign staging attestation")process.exit(1);
        if(complete==="1"&&(x.status!=="completed"||x.conclusion!=="success"))process.exit(1);
      });' "$RUN_ID" "$TITLE" "$RUNTIME_SHA" "$require_complete"
}
validate_run_identity 0 || { echo "staging signing run identity is invalid" >&2; exit 1; }
gh run watch "$RUN_ID" --exit-status
validate_run_identity 1 || { echo "completed staging signing run identity is invalid" >&2; exit 1; }

OUTPUT_BASENAME="$(basename "$OUTPUT")"
install -d -m 700 "$(dirname "$OUTPUT")"
OUTPUT_DIRECTORY="$(cd "$(dirname "$OUTPUT")" && pwd)"
OUTPUT="$OUTPUT_DIRECTORY/$OUTPUT_BASENAME"
DOWNLOAD="$(mktemp -d "$OUTPUT_DIRECTORY/.staging-signing-download-${REQUEST_ID}.XXXXXX")"
cleanup_download() {
  case "$DOWNLOAD" in "$OUTPUT_DIRECTORY"/.staging-signing-download-"$REQUEST_ID".*) rm -rf "$DOWNLOAD" ;; esac
}
trap cleanup_download EXIT
gh run download "$RUN_ID" --name "staging-attestation-$REQUEST_ID" --dir "$DOWNLOAD"
SIGNED_FILES="$(find "$DOWNLOAD" -type f -name staging-attestation.json -print)"
[ "$(printf '%s\n' "$SIGNED_FILES" | sed '/^$/d' | wc -l | tr -d ' ')" = 1 ] \
  || { echo "signed staging attestation artifact is missing or ambiguous" >&2; exit 1; }
SIGNED="$SIGNED_FILES"
node scripts/release-staging-attestation.mjs validate \
  --attestation "$SIGNED" --manifest "$MANIFEST" --expect-runtime-sha "$RUNTIME_SHA" \
  --expect-installed-runtime-digest "$INSTALLED_RUNTIME_DIGEST" \
  --expect-recovery-runtime-digest "$RECOVERY_RUNTIME_DIGEST" >/dev/null
node - "$REQUEST" "$SIGNED" "$REQUEST_SHA256" "$RUN_ID" <<'NODE'
const crypto=require('node:crypto');
const fs=require('node:fs');
const [requestPath,signedPath,expectedSha,expectedRunId]=process.argv.slice(2);
const GITHUB_REQUEST_CHRONOLOGY_TOLERANCE_MS=5_000;
const canonical=(value)=>value===null||typeof value!=='object'
  ?JSON.stringify(value)
  :Array.isArray(value)
    ?`[${value.map(canonical).join(',')}]`
    :`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const requestBody=fs.readFileSync(requestPath);
if(crypto.createHash('sha256').update(requestBody).digest('hex')!==expectedSha){
  throw new Error('staging request bytes drifted before signed evidence publication');
}
const request=JSON.parse(requestBody);
const signed=JSON.parse(fs.readFileSync(signedPath,'utf8'));
const {protectedSigning,...signedRequest}=signed.payload??{};
if(canonical(signedRequest)!==canonical(request)){
  throw new Error('signed staging payload differs from the exact checkpointed request');
}
if(protectedSigning?.workflow!=='.github/workflows/sign-staging-attestation.yml'
  ||protectedSigning.runId!==expectedRunId
  ||!/^[1-9][0-9]*$/.test(protectedSigning.runId??'')
  ||!/^[1-9][0-9]*$/.test(protectedSigning.runAttempt??'')
  ||!Number.isFinite(Date.parse(protectedSigning.signedAt??''))
  ||(protectedSigning.requestedAt!==undefined
    &&(!Number.isFinite(Date.parse(protectedSigning.requestedAt))
      ||new Date(Date.parse(protectedSigning.requestedAt)).toISOString()!==protectedSigning.requestedAt
      ||Date.parse(protectedSigning.requestedAt)+GITHUB_REQUEST_CHRONOLOGY_TOLERANCE_MS
        <Date.parse(request.verifiedAt)
      ||Date.parse(protectedSigning.requestedAt)>Date.parse(protectedSigning.signedAt)))
  ||Date.parse(protectedSigning.signedAt)<Date.parse(request.verifiedAt)){
  throw new Error('signed staging payload lacks protected signing timing');
}
NODE
node - "$SIGNED" "$OUTPUT" <<'NODE'
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const [source,destination]=process.argv.slice(2);
const body=fs.readFileSync(source);
const sourceStat=fs.lstatSync(source),parent=path.dirname(destination);
const parentStat=fs.lstatSync(parent);
if(!sourceStat.isFile()||sourceStat.isSymbolicLink()||sourceStat.size<=0
  ||sourceStat.size>2*1024*1024||!parentStat.isDirectory()||parentStat.isSymbolicLink()){
  throw new Error('downloaded staging attestation path is unsafe');
}
const fsyncParent=()=>{
  const fd=fs.openSync(parent,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
};
try{
  const existing=fs.lstatSync(destination);
  if(!existing.isFile()||existing.isSymbolicLink()||(existing.mode&0o777)!==0o600
    ||existing.nlink!==1||!fs.readFileSync(destination).equals(body)){
    throw new Error('existing staging attestation differs from the exact signer artifact');
  }
}catch(error){
  if(error?.code!=='ENOENT')throw error;
  const temporary=path.join(parent,`.${path.basename(destination)}.next.${process.pid}.${crypto.randomBytes(8).toString('hex')}`);
  let fd;
  try{
    fd=fs.openSync(temporary,'wx',0o600);
    fs.writeFileSync(fd,body);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    fs.linkSync(temporary,destination);fsyncParent();
    fs.unlinkSync(temporary);fsyncParent();
  }finally{
    if(fd!==undefined)fs.closeSync(fd);
    try{fs.unlinkSync(temporary);}catch(cleanupError){if(cleanupError?.code!=='ENOENT')throw cleanupError;}
  }
}
NODE
node scripts/release-staging-attestation.mjs validate \
  --attestation "$OUTPUT" --manifest "$MANIFEST" --expect-runtime-sha "$RUNTIME_SHA" \
  --expect-installed-runtime-digest "$INSTALLED_RUNTIME_DIGEST" \
  --expect-recovery-runtime-digest "$RECOVERY_RUNTIME_DIGEST"
