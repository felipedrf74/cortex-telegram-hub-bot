#!/usr/bin/env bash
# Request a protected drill-only bundle containing ordinary release evidence.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
STAGING_REQUEST="${1:?ordinary staging request path is required}"
MANIFEST="${2:?production-signed release manifest path is required}"
OUTPUT_DIRECTORY="${3:?new drill staging bundle output directory is required}"
shift 3
RUN_ID=""
MANIFEST_SIGNING_RUN_ID=""
BUNDLE_ROOT=""
DRILL_PUBLIC_KEY="$ROOT/docs/release/evidence/rollback-drill-staging-public-key.pem"
while [ $# -gt 0 ]; do
  case "$1" in
    --run-id) RUN_ID="$2"; shift 2 ;;
    --manifest-signing-run-id) MANIFEST_SIGNING_RUN_ID="$2"; shift 2 ;;
    --bundle-root) BUNDLE_ROOT="$2"; shift 2 ;;
    --drill-public-key) DRILL_PUBLIC_KEY="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: scripts/request-rollback-drill-staging-attestation.sh <ordinary-staging-request> <production-manifest> <new-output-directory> --manifest-signing-run-id <id> [--bundle-root <exact-bundle>] [--drill-public-key <reviewed-public-key>] [--run-id <id>]"
      exit 0
      ;;
    *) echo "Unknown argument: $1" >&2; exit 64 ;;
  esac
done

[[ "$MANIFEST_SIGNING_RUN_ID" =~ ^[1-9][0-9]*$ ]] \
  || { echo "exact release-manifest signing run id is required" >&2; exit 64; }
[[ -z "$RUN_ID" || "$RUN_ID" =~ ^[1-9][0-9]*$ ]] \
  || { echo "invalid rollback-drill staging signing run id" >&2; exit 64; }
[ -f "$STAGING_REQUEST" ] && [ ! -L "$STAGING_REQUEST" ] \
  || { echo "ordinary staging request is missing or unsafe" >&2; exit 64; }
[ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] \
  || { echo "production-signed release manifest is missing or unsafe" >&2; exit 64; }
[ -f "$DRILL_PUBLIC_KEY" ] && [ ! -L "$DRILL_PUBLIC_KEY" ] \
  || { echo "reviewed rollback-drill staging public key is not provisioned" >&2; exit 77; }
[ ! -e "$OUTPUT_DIRECTORY" ] && [ ! -L "$OUTPUT_DIRECTORY" ] \
  || { echo "drill staging output directory must not already exist" >&2; exit 64; }

command -v gh >/dev/null 2>&1 \
  || { echo "GitHub CLI is required to request rollback-drill staging signing" >&2; exit 1; }
gh auth status >/dev/null 2>&1 \
  || { echo "GitHub CLI authentication is required" >&2; exit 1; }

read_staging_field() {
  node -e 'const x=require(process.argv[1]);const v=x[process.argv[2]];if(v==null)process.exit(2);process.stdout.write(String(v));' \
    "$STAGING_REQUEST" "$1"
}

REQUEST_ID="$(read_staging_field requestId)"
RUNTIME_SHA="$(read_staging_field runtimeSha)"
ARTIFACT_DIGEST="$(read_staging_field artifactDigest)"
[[ "$REQUEST_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
  || { echo "invalid staging request id" >&2; exit 64; }
[[ "$RUNTIME_SHA" =~ ^[0-9a-f]{40}$ && "$ARTIFACT_DIGEST" =~ ^[0-9a-f]{64}$ ]] \
  || { echo "invalid staging release identity" >&2; exit 64; }
if [ -z "$BUNDLE_ROOT" ]; then
  BUNDLE_ROOT="$ROOT/.local/release/bundles/$RUNTIME_SHA/$ARTIFACT_DIGEST"
fi
[ -d "$BUNDLE_ROOT" ] && [ ! -L "$BUNDLE_ROOT" ] \
  || { echo "exact release bundle is required for source-manifest validation" >&2; exit 64; }

node scripts/release-manifest-v2.mjs validate \
  --manifest "$MANIFEST" \
  --root "$BUNDLE_ROOT" \
  --verify-bundle \
  --public-key "$ROOT/docs/release/evidence/release-evidence-public-key.pem" \
  --expect-runtime-sha "$RUNTIME_SHA"

REQUEST_PARENT="$ROOT/.local/release/rollback-drill-staging/requests"
install -d -m 700 "$ROOT/.local" "$ROOT/.local/release" \
  "$ROOT/.local/release/rollback-drill-staging" "$REQUEST_PARENT"
REQUEST="$(mktemp "$REQUEST_PARENT/.${REQUEST_ID}.XXXXXXXX.json")"
rm -f "$REQUEST"
cleanup_request() {
  case "$REQUEST" in "$REQUEST_PARENT"/."$REQUEST_ID".*.json) rm -f "$REQUEST" ;; esac
}
trap cleanup_request EXIT
node scripts/rollback-drill-staging-attestation.mjs request \
  --staging-request "$STAGING_REQUEST" \
  --manifest "$MANIFEST" \
  --manifest-signing-run-id "$MANIFEST_SIGNING_RUN_ID" \
  --production-public-key "$ROOT/docs/release/evidence/release-evidence-public-key.pem" \
  --expect-runtime-sha "$RUNTIME_SHA" \
  --output "$REQUEST" >/dev/null

REQUEST_B64="$(base64 < "$REQUEST" | tr -d '\r\n')"
[ -n "$REQUEST_B64" ] && [ "${#REQUEST_B64}" -le 60000 ] \
  || { echo "encoded rollback-drill staging request is too large" >&2; exit 1; }
REQUEST_SHA256="$(
  node -e 'const c=require("node:crypto"),f=require("node:fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' \
    "$REQUEST"
)"
SIGNING_WORKFLOW="sign-staging-attestation.yml"
gh workflow view "$SIGNING_WORKFLOW" --ref main --yaml >/dev/null 2>&1 || {
  echo "protected-main rollback-drill staging signing workflow is unavailable" >&2
  exit 1
}
TITLE="Sign rollback_drill_staging $REQUEST_ID digest $REQUEST_SHA256"
if [ -z "$RUN_ID" ]; then
  gh workflow run "$SIGNING_WORKFLOW" --ref main \
    -f "evidence_kind=rollback_drill_staging" \
    -f "request_id=$REQUEST_ID" \
    -f "runtime_sha=$RUNTIME_SHA" \
    -f "request_sha256=$REQUEST_SHA256" \
    -f "request_b64=$REQUEST_B64"
  for _ in $(seq 1 30); do
    RUN_ID="$(EXPECTED_TITLE="$TITLE" EXPECTED_SHA="$RUNTIME_SHA" \
      gh run list --workflow "$SIGNING_WORKFLOW" --branch main \
        --event workflow_dispatch --limit 50 \
        --json databaseId,displayTitle,headSha,headBranch,event \
      | node -e '
        let body="";process.stdin.on("data",c=>body+=c);process.stdin.on("end",()=>{
          const rows=JSON.parse(body).filter((row)=>row.displayTitle===process.env.EXPECTED_TITLE
            &&row.headSha===process.env.EXPECTED_SHA&&row.headBranch==="main"
            &&row.event==="workflow_dispatch");
          if(rows.length>1)process.exit(65);
          if(rows.length===1)process.stdout.write(String(rows[0].databaseId));
        });'
    )" || { echo "rollback-drill staging signing correlation is ambiguous" >&2; exit 65; }
    [ -z "$RUN_ID" ] || break
    sleep 2
  done
fi
[ -n "$RUN_ID" ] \
  || { echo "rollback-drill staging signing workflow run was not found" >&2; exit 1; }

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
validate_run_identity 0 || { echo "rollback-drill staging signing run identity is invalid" >&2; exit 1; }
gh run watch "$RUN_ID" --exit-status
validate_run_identity 1 || { echo "completed rollback-drill staging run identity is invalid" >&2; exit 1; }

OUTPUT_PARENT="$(cd "$(dirname "$OUTPUT_DIRECTORY")" && pwd)"
OUTPUT_DIRECTORY="$OUTPUT_PARENT/$(basename "$OUTPUT_DIRECTORY")"
DOWNLOAD="$(mktemp -d "$OUTPUT_PARENT/.rollback-drill-staging-${REQUEST_ID}.XXXXXXXX")"
cleanup_download() {
  case "$DOWNLOAD" in "$OUTPUT_PARENT"/.rollback-drill-staging-"$REQUEST_ID".*) rm -rf "$DOWNLOAD" ;; esac
}
trap 'cleanup_request; cleanup_download' EXIT
gh run download "$RUN_ID" \
  --name "rollback-drill-staging-bundle-$REQUEST_ID" \
  --dir "$DOWNLOAD"
BINDING_FILES="$(find "$DOWNLOAD" -type f -name drill-binding.json -print)"
[ "$(printf '%s\n' "$BINDING_FILES" | sed '/^$/d' | wc -l | tr -d ' ')" = 1 ] \
  || { echo "signed rollback-drill staging bundle is missing or ambiguous" >&2; exit 1; }
SIGNED_DIRECTORY="$(dirname "$BINDING_FILES")"
node scripts/rollback-drill-staging-attestation.mjs validate \
  --bundle "$SIGNED_DIRECTORY" \
  --request "$REQUEST" \
  --source-manifest "$MANIFEST" \
  --drill-public-key "$DRILL_PUBLIC_KEY" \
  --production-public-key "$ROOT/docs/release/evidence/release-evidence-public-key.pem" \
  --expect-runtime-sha "$RUNTIME_SHA" >/dev/null

node - "$SIGNED_DIRECTORY" "$OUTPUT_DIRECTORY" <<'NODE'
const fs=require('node:fs');
const path=require('node:path');
const [source,destination]=process.argv.slice(2);
const parent=path.dirname(destination);
if(fs.existsSync(destination))throw new Error('rollback-drill staging output already exists');
const parentStat=fs.lstatSync(parent);
if(!parentStat.isDirectory()||parentStat.isSymbolicLink())throw new Error('output parent is unsafe');
const temporary=path.join(parent,`.${path.basename(destination)}.next.${process.pid}`);
fs.mkdirSync(temporary,{mode:0o700});
try{
  for(const name of ['drill-binding.json','release-manifest.json','staging-attestation.json']){
    const input=path.join(source,name),body=fs.readFileSync(input),stat=fs.lstatSync(input);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||body.length===0){
      throw new Error(`signed bundle file is unsafe: ${name}`);
    }
    const fd=fs.openSync(path.join(temporary,name),'wx',0o600);
    try{fs.writeFileSync(fd,body);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  }
  let fd=fs.openSync(temporary,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(temporary,destination);
  fd=fs.openSync(parent,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}finally{fs.rmSync(temporary,{recursive:true,force:true});}
NODE
node scripts/rollback-drill-staging-attestation.mjs validate \
  --bundle "$OUTPUT_DIRECTORY" \
  --request "$REQUEST" \
  --source-manifest "$MANIFEST" \
  --drill-public-key "$DRILL_PUBLIC_KEY" \
  --production-public-key "$ROOT/docs/release/evidence/release-evidence-public-key.pem" \
  --expect-runtime-sha "$RUNTIME_SHA"
