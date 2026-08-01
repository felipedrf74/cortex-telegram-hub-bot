#!/usr/bin/env bash
# Lean exact-artifact release operator.
#
# prepare: resolve one successful release checkpoint, download the original
# protected-main artifact, upload it once, and stage it through systemd-run.
# promote: require explicit owner confirmation, then submit one production
# transaction that survives the caller's SSH session.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/lib/release-gates.sh"

COMMAND="${1:-status}"
[ $# -eq 0 ] || shift
SERVER="${DEPLOY_SERVER:-ServerDominguez}"
SERVER_EXPLICIT=false
MANIFEST=""
MANIFEST_SHA256=""
CHECKPOINT_RUN=""
CONFIRM=""
DRY_RUN=false
EXPECTED_SHA=""
STAGING_FAULT_AFTER_SWITCH=false
FIRST_INSTALL=false
CANONICAL_DEPLOYED_SHA=""
CANONICAL_DEPLOYED_DIGEST=""

usage() {
  cat <<'USAGE'
Usage:
  scripts/release-operator.sh prepare [--checkpoint-run ID] [--server HOST] [--staging-fault-after-switch] [--first-install] [--dry-run]
  scripts/release-operator.sh promote --confirm SHA:DIGEST [--server HOST] [--dry-run]
  scripts/release-operator.sh status [--server HOST]

`prepare` reuses the exact protected-main artifact and stops after staging.
`promote` also requires NEXUS_RELEASE_OWNER_AUTHORIZED=1.
The staging fault drill additionally requires NEXUS_RELEASE_DRILL_AUTHORIZED=1.
`--first-install` is staging-only, requires NEXUS_RELEASE_OWNER_AUTHORIZED=1, and
is refused by the remote transaction whenever a predecessor already exists.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --checkpoint-run) CHECKPOINT_RUN="${2:?--checkpoint-run requires an ID}"; shift 2 ;;
    --server) SERVER="${2:?--server requires a host}"; SERVER_EXPLICIT=true; shift 2 ;;
    --confirm) CONFIRM="${2:?--confirm requires SHA:DIGEST}"; shift 2 ;;
    --sha) EXPECTED_SHA="${2:?--sha requires a full SHA}"; shift 2 ;;
    --staging-fault-after-switch) STAGING_FAULT_AFTER_SWITCH=true; shift ;;
    --first-install) FIRST_INSTALL=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown release argument: $1" >&2; usage >&2; exit 64 ;;
  esac
done

[[ "$SERVER" =~ ^[A-Za-z0-9._@-]+$ ]] || { echo "invalid deploy server" >&2; exit 64; }
case "$COMMAND" in
  prepare|promote|status) ;;
  *) usage >&2; exit 64 ;;
esac
[ "$STAGING_FAULT_AFTER_SWITCH" = false ] || {
  [ "$COMMAND" = prepare ] || {
    echo "--staging-fault-after-switch is valid only for prepare" >&2
    exit 64
  }
  [ "${NEXUS_RELEASE_DRILL_AUTHORIZED:-0}" = 1 ] || {
    echo "staging fault drill requires NEXUS_RELEASE_DRILL_AUTHORIZED=1" >&2
    exit 1
  }
}
# First install exists only to bootstrap a staging host that has never completed
# a release. It never reaches production: `promote` refuses the flag here, and
# the remote transaction refuses role=promote and any existing predecessor.
FIRST_INSTALL_SETENV=()
[ "$FIRST_INSTALL" = false ] || {
  [ "$COMMAND" = prepare ] || {
    echo "--first-install is valid only for prepare" >&2
    exit 64
  }
  [ "$STAGING_FAULT_AFTER_SWITCH" = false ] || {
    echo "--first-install cannot be combined with the staging fault drill" >&2
    exit 64
  }
  [ "${NEXUS_RELEASE_OWNER_AUTHORIZED:-0}" = 1 ] || {
    echo "first install requires NEXUS_RELEASE_OWNER_AUTHORIZED=1" >&2
    exit 1
  }
  FIRST_INSTALL_SETENV=(--setenv=NEXUS_RELEASE_ALLOW_FIRST_INSTALL=1)
}

STATE_ROOT="$ROOT/.local/release"
STATE_FILE="$STATE_ROOT/release.json"
MANIFEST_ROOT="$STATE_ROOT/manifests"
BUNDLE_ROOT="$STATE_ROOT/bundles"
TRANSACTION_ROOT="$STATE_ROOT/transactions"

install -d -m 700 "$ROOT/.local" "$STATE_ROOT" "$MANIFEST_ROOT" "$BUNDLE_ROOT" "$TRANSACTION_ROOT"

write_local_state() {
  local phase="$1"
  local staging_state="${2:-}"
  local production_state="${3:-}"
  node - "$STATE_FILE" "$phase" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$ARTIFACT_NAME" \
    "$MANIFEST" "$MANIFEST_SHA256" "$CANONICAL_DEPLOYED_SHA" \
    "$CANONICAL_DEPLOYED_DIGEST" "$CHECKPOINT_RUN" \
    "$SERVER" "$staging_state" "$production_state" <<'NODE'
const fs=require('node:fs');const path=require('node:path');
const [file,phase,runtimeSha,artifactDigest,artifactName,manifest,manifestSha256,
 deployedSha,deployedArtifactDigest,checkpointRun,server,
 stagingPath,productionPath]=process.argv.slice(2);
const read=(filename)=>{
 if(!filename)return null;
 const value=JSON.parse(fs.readFileSync(filename,'utf8'));
 return value;
};
const body=Buffer.from(`${JSON.stringify({
 schema:'nexus.lean-release-state.v1',phase,runtimeSha,artifactDigest,artifactName,
 manifest:path.resolve(manifest),manifestSha256,deployedSha,deployedArtifactDigest,
 checkpointRun:Number(checkpointRun),server,
 staging:read(stagingPath),production:read(productionPath),updatedAt:new Date().toISOString(),
},null,2)}\n`);
const temporary=`${file}.next-${process.pid}`;
const descriptor=fs.openSync(temporary,'wx',0o600);
try{fs.writeFileSync(descriptor,body);fs.fsyncSync(descriptor);}
finally{fs.closeSync(descriptor);}
fs.renameSync(temporary,file);
const parent=fs.openSync(path.dirname(file),'r');
try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
NODE
}

manifest_value() {
  node -e '
const x=require(process.argv[1]);
let value=x;
for(const key of process.argv[2].split("."))value=value?.[key];
if(value===undefined||value===null)process.exit(1);
process.stdout.write(String(value));' "$(cd "$(dirname "$MANIFEST")" && pwd)/$(basename "$MANIFEST")" "$1"
}

require_exact_checkout() {
  release_require_git_worktree "$ROOT"
  release_require_clean_tree "$ROOT" || {
    echo "release commands require a clean exact protected-main checkout" >&2
    exit 1
  }
  RUNTIME_SHA="$(git rev-parse HEAD)"
  [[ "$RUNTIME_SHA" =~ ^[0-9a-f]{40}$ ]] || {
    echo "checked-out runtime SHA is invalid" >&2
    exit 1
  }
  [ -z "$EXPECTED_SHA" ] || [ "$EXPECTED_SHA" = "$RUNTIME_SHA" ] || {
    echo "checked-out runtime SHA differs from --sha" >&2
    exit 1
  }
  git fetch --quiet --no-tags origin main
  [ "$(git rev-parse origin/main)" = "$RUNTIME_SHA" ] || {
    echo "release target is not the exact current protected origin/main SHA" >&2
    exit 1
  }
  read -r CANONICAL_DEPLOYED_SHA CANONICAL_DEPLOYED_DIGEST < <(
    release_read_deployed_identity "$ROOT/docs/release/release-state.json"
  )
  [[ "$CANONICAL_DEPLOYED_SHA" =~ ^[0-9a-f]{40}$ ]] || {
    echo "canonical protected release-state SHA is invalid" >&2
    exit 1
  }
  [[ "$CANONICAL_DEPLOYED_DIGEST" =~ ^[0-9a-f]{64}$ ]] || {
    echo "canonical protected release-state artifact digest is invalid" >&2
    exit 1
  }
  git merge-base --is-ancestor "$CANONICAL_DEPLOYED_SHA" "$RUNTIME_SHA" || {
    echo "canonical deployed SHA is not an ancestor of the release target" >&2
    exit 1
  }
}

resolve_checkpoint_run() {
  if [ -n "$CHECKPOINT_RUN" ]; then
    [[ "$CHECKPOINT_RUN" =~ ^[1-9][0-9]*$ ]] || {
      echo "checkpoint run ID is invalid" >&2
      exit 64
    }
    return
  fi
  CHECKPOINT_RUN="$(gh run list \
    --workflow release-candidate-evidence.yml \
    --branch main \
    --event workflow_dispatch \
    --commit "$RUNTIME_SHA" \
    --status success \
    --limit 10 \
    --json databaseId,headSha,status,conclusion,createdAt \
    --jq "map(select(.headSha==\"$RUNTIME_SHA\" and .status==\"completed\" and .conclusion==\"success\")) | sort_by(.createdAt,.databaseId) | last | .databaseId // empty")"
  [[ "$CHECKPOINT_RUN" =~ ^[1-9][0-9]*$ ]] || {
    echo "no successful exact-SHA release checkpoint exists" >&2
    exit 1
  }
}

validate_checkpoint_run() {
  local run
  run="$(gh run view "$CHECKPOINT_RUN" \
    --json headSha,headBranch,event,status,conclusion,workflowName)"
  node - "$run" "$RUNTIME_SHA" <<'NODE'
const run=JSON.parse(process.argv[2]),sha=process.argv[3];
if(run.headSha!==sha||run.headBranch!=='main'||run.event!=='workflow_dispatch'
 ||run.status!=='completed'||run.conclusion!=='success'
 ||run.workflowName!=='Release Checkpoint — exact main artifact')process.exit(1);
NODE
}

download_manifest() {
  MANIFEST="$MANIFEST_ROOT/$RUNTIME_SHA.json"
  local temporary
  if [ -e "$MANIFEST" ] || [ -L "$MANIFEST" ]; then
    [ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] || {
      echo "cached manifest path is unsafe" >&2
      exit 1
    }
  fi
  temporary="$(mktemp -d "$MANIFEST_ROOT/.download-$RUNTIME_SHA.XXXXXX")"
  gh run download "$CHECKPOINT_RUN" \
    --name "release-checkpoint-$RUNTIME_SHA" \
    --dir "$temporary"
  local downloaded="$temporary/release-manifest.json"
  [ -f "$downloaded" ] && [ ! -L "$downloaded" ] || {
    rm -rf "$temporary"
    echo "release checkpoint manifest was not downloaded" >&2
    exit 1
  }
  mv "$downloaded" "$MANIFEST"
  chmod 600 "$MANIFEST"
  rmdir "$temporary"
}

sha256_file() {
  node -e '
const fs=require("node:fs"),crypto=require("node:crypto");
const file=process.argv[1],stat=fs.lstatSync(file);
if(!stat.isFile()||stat.isSymbolicLink()||stat.size===0||stat.size>16*1024*1024)process.exit(1);
process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
' "$1"
}

resolve_manifest_identity() {
  node scripts/release-checksum-manifest.mjs validate \
    --manifest "$MANIFEST" \
    --expect-source-sha "$RUNTIME_SHA" \
    --expect-artifact-digest "${ARTIFACT_DIGEST:-}" >/dev/null
  ARTIFACT_NAME="$(manifest_value artifact.name)"
  ARTIFACT_DIGEST="$(manifest_value artifact.sha256)"
  MANIFEST_DEPLOYED_SHA="$(manifest_value releaseImpact.deployedSha)"
  PROTECTED_RUN="$(manifest_value protectedMain.runId)"
  MANIFEST_CHECKPOINT_RUN="$(manifest_value releaseCheckpoint.runId)"
  MIGRATION_APPROVAL_REQUIRED="$(manifest_value migrations.approvalRequired)"
  [ "$MANIFEST_CHECKPOINT_RUN" = "$CHECKPOINT_RUN" ] || {
    echo "release manifest is not bound to the selected checkpoint run" >&2
    exit 1
  }
  [ "$MIGRATION_APPROVAL_REQUIRED" = false ] || {
    echo "irreversible migrations are not promotable through the lean release path" >&2
    exit 1
  }
  [ "$ARTIFACT_NAME" = "release-bundle-$RUNTIME_SHA-$ARTIFACT_DIGEST" ] || {
    echo "release manifest artifact identity is not exact" >&2
    exit 1
  }
  [ "$MANIFEST_DEPLOYED_SHA" = "$CANONICAL_DEPLOYED_SHA" ] || {
    echo "release manifest deployed SHA is not the canonical protected release state" >&2
    exit 1
  }
}

redownload_and_verify_manifest() {
  local temporary downloaded
  temporary="$(mktemp -d "$MANIFEST_ROOT/.revalidate-$RUNTIME_SHA.XXXXXX")"
  if ! gh run download "$CHECKPOINT_RUN" \
      --name "release-checkpoint-$RUNTIME_SHA" \
      --dir "$temporary"; then
    rm -rf -- "$temporary"
    echo "exact checkpoint manifest artifact is missing or expired" >&2
    exit 1
  fi
  downloaded="$temporary/release-manifest.json"
  if ! node scripts/release-checksum-manifest.mjs verify-cache \
      --manifest "$MANIFEST" \
      --downloaded-manifest "$downloaded" \
      --expect-manifest-sha256 "$MANIFEST_SHA256" \
      --expect-source-sha "$RUNTIME_SHA" \
      --expect-artifact-digest "$ARTIFACT_DIGEST" >/dev/null; then
    rm -rf -- "$temporary"
    echo "exact checkpoint manifest no longer matches prepared release state" >&2
    exit 1
  fi
  rm -rf -- "$temporary"
}

download_bundle() {
  BUNDLE="$BUNDLE_ROOT/$RUNTIME_SHA/$ARTIFACT_DIGEST"
  if [ -d "$BUNDLE" ]; then
    node scripts/release-artifact-manifest.mjs \
      --verify-bundle "$BUNDLE" \
      --expected-runtime-sha "$RUNTIME_SHA" \
      --expected-digest "$ARTIFACT_DIGEST" >/dev/null
    return
  fi
  local parent temporary
  parent="$BUNDLE_ROOT/$RUNTIME_SHA"
  install -d -m 700 "$parent"
  temporary="$(mktemp -d "$parent/.download-$ARTIFACT_DIGEST.XXXXXX")"
  gh run download "$PROTECTED_RUN" --name "$ARTIFACT_NAME" --dir "$temporary"
  node scripts/release-artifact-manifest.mjs \
    --verify-bundle "$temporary" \
    --expected-runtime-sha "$RUNTIME_SHA" \
    --expected-digest "$ARTIFACT_DIGEST" >/dev/null
  mv "$temporary" "$BUNDLE"
  chmod -R u=rwX,go= "$BUNDLE"
}

resolve_existing_state() {
  [ -f "$STATE_FILE" ] || {
    echo "no prepared release state exists; run release:prepare first" >&2
    exit 1
  }
  eval "$(node - "$STATE_FILE" <<'NODE'
const x=require(process.argv[2]);
const quote=(value)=>`'${String(value).replaceAll("'","'\\''")}'`;
if(x.schema!=='nexus.lean-release-state.v1')process.exit(1);
for(const [key,value] of [
 ['RUNTIME_SHA',x.runtimeSha],['ARTIFACT_DIGEST',x.artifactDigest],
 ['ARTIFACT_NAME',x.artifactName],['MANIFEST',x.manifest],
 ['MANIFEST_SHA256',x.manifestSha256],['STATE_DEPLOYED_SHA',x.deployedSha],
 ['STATE_DEPLOYED_DIGEST',x.deployedArtifactDigest],
 ['CHECKPOINT_RUN',x.checkpointRun],['STATE_PHASE',x.phase],
 ['STATE_SERVER',x.server],
])console.log(`${key}=${quote(value)}`);
NODE
)"
  [[ "$RUNTIME_SHA" =~ ^[0-9a-f]{40}$
    && "$ARTIFACT_DIGEST" =~ ^[0-9a-f]{64}$
    && "$MANIFEST_SHA256" =~ ^[0-9a-f]{64}$
    && "$STATE_DEPLOYED_SHA" =~ ^[0-9a-f]{40}$
    && "$STATE_DEPLOYED_DIGEST" =~ ^[0-9a-f]{64}$
    && "$CHECKPOINT_RUN" =~ ^[1-9][0-9]*$ ]] || {
    echo "prepared release state identity is invalid" >&2
    exit 1
  }
  [ "$MANIFEST" = "$MANIFEST_ROOT/$RUNTIME_SHA.json" ] \
    && [ "$STATE_DEPLOYED_SHA" = "$CANONICAL_DEPLOYED_SHA" ] \
    && [ "$STATE_DEPLOYED_DIGEST" = "$CANONICAL_DEPLOYED_DIGEST" ] || {
    echo "prepared release state manifest or deployed identity is invalid" >&2
    exit 1
  }
  if [ "$SERVER_EXPLICIT" = true ]; then
    [ "$SERVER" = "$STATE_SERVER" ] || {
      echo "explicit server differs from the prepared release server" >&2
      exit 1
    }
  else
    SERVER="$STATE_SERVER"
  fi
  [[ "$SERVER" =~ ^[A-Za-z0-9._@-]+$ ]] || {
    echo "prepared release server is invalid" >&2
    exit 1
  }
}

transaction_id() {
  printf '%s-%s' "$(date -u +%Y%m%dT%H%M%SZ)" "$(node -e 'process.stdout.write(require("crypto").randomBytes(6).toString("hex"))')"
}

poll_remote_transaction() {
  local role="$1"
  local id="$2"
  local output="$3"
  local deadline=$((SECONDS + 600))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if ssh "$SERVER" test -f "/home/dominguez/.local/state/nexus-release/$role.json"; then
      ssh "$SERVER" cat "/home/dominguez/.local/state/nexus-release/$role.json" > "$output.next"
      if node - "$output.next" "$role" "$id" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" <<'NODE'
const fs=require('node:fs');
const x=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const [role,id,sha,digest]=process.argv.slice(3);
if(x.schema!=='nexus.lean-release-transaction.v1'||x.role!==role
 ||x.transactionId!==id||x.runtimeSha!==sha||x.artifactDigest!==digest)process.exit(1);
if(x.status==='passed'&&x.phase==='completed')process.exit(0);
if(x.status==='failed')process.exit(2);
process.exit(3);
NODE
      then
        mv "$output.next" "$output"
        chmod 600 "$output"
        return 0
      else
        case "$?" in
          2)
            mv "$output.next" "$output"
            chmod 600 "$output"
            cat "$output" >&2
            return 1
            ;;
          3) rm -f "$output.next" ;;
          *) rm -f "$output.next"; echo "remote $role transaction state is invalid" >&2; return 1 ;;
        esac
      fi
    fi
    sleep 2
  done
  echo "remote $role transaction did not finish within ten minutes" >&2
  return 75
}

case "$COMMAND" in
  status)
    if [ -f "$STATE_FILE" ]; then
      cat "$STATE_FILE"
    else
      printf '{"schema":"nexus.lean-release-state.v1","phase":"not_prepared"}\n'
    fi
    if ssh -o BatchMode=yes -o ConnectTimeout=5 "$SERVER" \
      test -d /home/dominguez/.local/state/nexus-release 2>/dev/null; then
      for role in staging production; do
        ssh "$SERVER" test -f "/home/dominguez/.local/state/nexus-release/$role.json" \
          && ssh "$SERVER" cat "/home/dominguez/.local/state/nexus-release/$role.json" || true
      done
    fi
    ;;

  prepare)
    require_exact_checkout
    command -v gh >/dev/null || { echo "GitHub CLI is required" >&2; exit 1; }
    resolve_checkpoint_run
    validate_checkpoint_run
    if [ "$DRY_RUN" = true ]; then
      printf '{"ok":true,"dryRun":true,"phase":"prepare","runtimeSha":"%s","checkpointRun":%s,"server":"%s"}\n' \
        "$RUNTIME_SHA" "$CHECKPOINT_RUN" "$SERVER"
      exit 0
    fi
    command -v rsync >/dev/null || { echo "rsync is required" >&2; exit 1; }
    download_manifest
    resolve_manifest_identity
    MANIFEST_SHA256="$(sha256_file "$MANIFEST")"
    [[ "$MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]] || {
      echo "downloaded checkpoint manifest digest is invalid" >&2
      exit 1
    }
    download_bundle
    trap release_cleanup_all_locks EXIT
    release_acquire_local_lock "$ROOT" release

    RELEASE_NAME="${RUNTIME_SHA}-${ARTIFACT_DIGEST:0:12}"
    REMOTE_BUNDLE="/home/dominguez/.local/share/nexus-release/incoming/$RELEASE_NAME"
    UPLOAD_ID="$(node -e 'process.stdout.write(require("crypto").randomBytes(6).toString("hex"))')"
    REMOTE_TEMP="/home/dominguez/.local/share/nexus-release/incoming/.${RELEASE_NAME}.uploading-$UPLOAD_ID"
    REMOTE_QUARANTINE="/home/dominguez/.local/share/nexus-release/incoming/.${RELEASE_NAME}.corrupt-$UPLOAD_ID"
    ssh "$SERVER" bash -s -- "$REMOTE_BUNDLE" "$REMOTE_TEMP" <<'REMOTE_PREPARE'
set -euo pipefail
bundle="$1"; temporary="$2"
install -d -m 700 /home/dominguez/.local/share/nexus-release/incoming
if [ -d "$bundle" ] && [ ! -L "$bundle" ]; then exit 0; fi
[ ! -e "$bundle" ] && [ ! -L "$bundle" ] || exit 1
[ ! -e "$temporary" ] && [ ! -L "$temporary" ] || exit 1
mkdir "$temporary"
REMOTE_PREPARE

    REMOTE_BUNDLE_REUSED=false
    if ssh "$SERVER" test -d "$REMOTE_BUNDLE" 2>/dev/null; then
      if ssh "$SERVER" /usr/bin/node \
          "$REMOTE_BUNDLE/scripts/release-artifact-manifest.mjs" \
          --verify-bundle "$REMOTE_BUNDLE" \
          --expected-runtime-sha "$RUNTIME_SHA" \
          --expected-digest "$ARTIFACT_DIGEST" >/dev/null 2>&1; then
        REMOTE_BUNDLE_REUSED=true
      else
        ssh "$SERVER" bash -s -- \
          "$REMOTE_BUNDLE" "$REMOTE_TEMP" "$REMOTE_QUARANTINE" <<'REMOTE_QUARANTINE_BUNDLE'
set -euo pipefail
bundle="$1"; temporary="$2"; quarantine="$3"
incoming=/home/dominguez/.local/share/nexus-release/incoming
case "$bundle" in "$incoming"/*) ;; *) exit 1 ;; esac
case "$temporary" in "$incoming"/.*.uploading-*) ;; *) exit 1 ;; esac
case "$quarantine" in "$incoming"/.*.corrupt-*) ;; *) exit 1 ;; esac
[ -d "$bundle" ] && [ ! -L "$bundle" ] || exit 1
[ ! -e "$temporary" ] && [ ! -L "$temporary" ] || exit 1
[ ! -e "$quarantine" ] && [ ! -L "$quarantine" ] || exit 1
mv -T "$bundle" "$quarantine"
mkdir "$temporary"
REMOTE_QUARANTINE_BUNDLE
      fi
    fi

    if [ "$REMOTE_BUNDLE_REUSED" != true ]; then
      rsync -a --delete --chmod=Du=rwx,Dgo=,Fu=rw,Fgo= \
        "$BUNDLE/" "$SERVER:$REMOTE_TEMP/"
      ssh "$SERVER" bash -s -- "$REMOTE_TEMP" "$REMOTE_BUNDLE" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" <<'REMOTE_PUBLISH'
set -euo pipefail
temporary="$1"; bundle="$2"; sha="$3"; digest="$4"
/usr/bin/node "$temporary/scripts/release-artifact-manifest.mjs" \
  --verify-bundle "$temporary" --expected-runtime-sha "$sha" --expected-digest "$digest" >/dev/null
if ! mv -T "$temporary" "$bundle" 2>/dev/null; then
  rm -rf -- "$temporary"
  [ -d "$bundle" ] && [ ! -L "$bundle" ] || exit 1
fi
REMOTE_PUBLISH
    fi
    ssh "$SERVER" /usr/bin/node "$REMOTE_BUNDLE/scripts/release-artifact-manifest.mjs" \
      --verify-bundle "$REMOTE_BUNDLE" \
      --expected-runtime-sha "$RUNTIME_SHA" \
      --expected-digest "$ARTIFACT_DIGEST" >/dev/null
    if ssh "$SERVER" test -d "$REMOTE_QUARANTINE" 2>/dev/null; then
      ssh "$SERVER" bash -s -- "$REMOTE_QUARANTINE" <<'REMOTE_REMOVE_QUARANTINE'
set -euo pipefail
quarantine="$1"
case "$quarantine" in
  /home/dominguez/.local/share/nexus-release/incoming/.*.corrupt-*) ;;
  *) exit 1 ;;
esac
[ -d "$quarantine" ] && [ ! -L "$quarantine" ] || exit 1
rm -rf -- "$quarantine"
REMOTE_REMOVE_QUARANTINE
    fi

    STAGING_STATE="$TRANSACTION_ROOT/staging-$RUNTIME_SHA-$ARTIFACT_DIGEST.json"
    rm -f -- "$STAGING_STATE" "$STAGING_STATE.next"
    REMOTE_STAGING_STATE="$(ssh "$SERVER" \
      cat /home/dominguez/.local/state/nexus-release/staging.json 2>/dev/null || true)"
    EXPECTED_STAGING_PREDECESSOR_SHA="$CANONICAL_DEPLOYED_SHA"
    EXPECTED_STAGING_PREDECESSOR_DIGEST="$CANONICAL_DEPLOYED_DIGEST"
    if [ -n "$REMOTE_STAGING_STATE" ]; then
      set +e
      STAGING_PREDECESSOR_IDENTITY="$(
        printf '%s' "$REMOTE_STAGING_STATE" | node -e '
let body="";process.stdin.on("data",chunk=>body+=chunk);process.stdin.on("end",()=>{
 const x=JSON.parse(body);
 if(x.schema!=="nexus.lean-release-transaction.v1"||x.role!=="staging")process.exit(1);
 let sha="",digest="";
 if(x.status==="passed"&&x.phase==="completed"){
   sha=x.runtimeSha;digest=x.artifactDigest;
 }else if(x.status==="failed"&&x.phase==="rolled_back"
   &&x.healthResult==="failed"&&x.rollbackResult==="restored"
   &&Number.isSafeInteger(x.rollbackDurationMs)&&x.rollbackDurationMs>=0
   &&Number.isSafeInteger(x.rollbackObjectiveSeconds)
   &&x.rollbackDurationMs<=x.rollbackObjectiveSeconds*1000){
   sha=x.predecessorSha;digest=x.predecessorDigest;
 }else if(x.status==="failed"
   &&x.message==="transaction stopped before runtime mutation"
   &&["starting","preparing"].includes(x.phase)&&x.healthResult==="pending"
   &&x.rollbackResult===null&&x.candidateRemoved===false){
   sha=x.predecessorSha;digest=x.predecessorDigest;
 }else process.exit(1);
 if(!/^[0-9a-f]{40}$/.test(sha||"")||!/^[0-9a-f]{64}$/.test(digest||""))process.exit(1);
 process.stdout.write(`${sha} ${digest}`);
});'
      )"
      staging_predecessor_status=$?
      set -e
      if [ "$staging_predecessor_status" -eq 0 ]; then
        read -r EXPECTED_STAGING_PREDECESSOR_SHA \
          EXPECTED_STAGING_PREDECESSOR_DIGEST <<<"$STAGING_PREDECESSOR_IDENTITY"
      fi
    fi
    if [ "$FIRST_INSTALL" = true ]; then
      # Send no predecessor identity at all. The remote transaction refuses the
      # first install if it observes any predecessor on the host, so this can
      # never be used to skip rollback protection on an established staging host.
      EXPECTED_STAGING_PREDECESSOR_SHA=""
      EXPECTED_STAGING_PREDECESSOR_DIGEST=""
    fi
    RESUME_TRANSACTION_ID=""
    if [ -n "$REMOTE_STAGING_STATE" ]; then
      set +e
      RESUME_TRANSACTION_ID="$(printf '%s' "$REMOTE_STAGING_STATE" | node -e '
let body="";process.stdin.on("data",chunk=>body+=chunk);process.stdin.on("end",()=>{
 const x=JSON.parse(body),[sha,digest]=process.argv.slice(1);
 if(x.schema!=="nexus.lean-release-transaction.v1"||x.role!=="staging"
   ||x.runtimeSha!==sha||x.artifactDigest!==digest)process.exit(3);
 if(x.status==="passed"&&x.phase==="completed"){
   // A completed first install is not "already staged". Its receipt has no
   // predecessor and can never be promoted, and re-staging this exact artifact
   // cannot fix that, because this artifact is the release now installed.
   if(x.firstInstall===true)process.exit(6);
   process.stdout.write(x.transactionId);process.exit(0);
 }
 if(x.status==="running"){process.stdout.write(x.transactionId);process.exit(4);}
 if(x.status==="failed"&&x.phase==="rolled_back"&&x.rollbackResult==="restored"
   &&x.faultInjection==="staging-health"&&x.candidateRemoved===true)process.exit(5);
 if(x.status==="failed"&&x.message==="transaction stopped before runtime mutation"
   &&["starting","preparing"].includes(x.phase)&&x.healthResult==="pending"
   &&x.rollbackResult===null&&x.candidateRemoved===false)process.exit(5);
 process.exit(2);
});' "$RUNTIME_SHA" "$ARTIFACT_DIGEST")"
      resume_status=$?
      set -e
      case "$resume_status" in
        0)
          [ "$STAGING_FAULT_AFTER_SWITCH" = false ] || {
            echo "the exact staging release already passed; the fault drill must use a new candidate" >&2
            exit 1
          }
          printf '%s\n' "$REMOTE_STAGING_STATE" > "$STAGING_STATE"
          chmod 600 "$STAGING_STATE"
          ;;
        4) poll_remote_transaction staging "$RESUME_TRANSACTION_ID" "$STAGING_STATE" ;;
        5) RESUME_TRANSACTION_ID="" ;;
        6)
          echo "this exact staging artifact was installed by a first-install bootstrap; that receipt has no predecessor and is not promotable. Stage the next release against it instead - see 'After a successful first install' in docs/release/README.md" >&2
          exit 1
          ;;
        2)
          echo "the exact staging transaction previously failed; inspect release:status before retrying" >&2
          exit 1
          ;;
        3) RESUME_TRANSACTION_ID="" ;;
        *) echo "remote staging transaction state is invalid" >&2; exit 1 ;;
      esac
    fi
    if [ ! -f "$STAGING_STATE" ]; then
      TRANSACTION_ID="$(transaction_id)"
      TRANSACTION_SUFFIX="${TRANSACTION_ID##*-}"
      UNIT="nexus-release-staging-${RUNTIME_SHA:0:12}-${TRANSACTION_SUFFIX}"
      if [ "$STAGING_FAULT_AFTER_SWITCH" = true ]; then
        ssh "$SERVER" systemd-run --user --quiet --collect \
          --unit "$UNIT" \
          --property Type=oneshot \
          --property TimeoutStartSec=8min \
          --setenv=NEXUS_RELEASE_FAULT_AFTER_SWITCH=staging-health \
          /bin/bash "$REMOTE_BUNDLE/scripts/remote-user-release-transaction.sh" \
          stage /home/dominguez/telegram-hub-bot-staging "$REMOTE_BUNDLE" "$RUNTIME_SHA" \
          "$ARTIFACT_DIGEST" "$TRANSACTION_ID" \
          "${NEXUS_RELEASE_STAGING_STABILITY_SECONDS:-15}" \
          "$EXPECTED_STAGING_PREDECESSOR_SHA" "$EXPECTED_STAGING_PREDECESSOR_DIGEST"
        if poll_remote_transaction staging "$TRANSACTION_ID" "$STAGING_STATE"; then
          echo "staging fault drill unexpectedly passed" >&2
          exit 1
        fi
        node - "$STAGING_STATE" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" <<'NODE'
const fs=require('node:fs');
const [file,sha,digest]=process.argv.slice(2);
const x=JSON.parse(fs.readFileSync(file,'utf8'));
if(x.schema!=='nexus.lean-release-transaction.v1'||x.role!=='staging'
 ||x.runtimeSha!==sha||x.artifactDigest!==digest||x.phase!=='rolled_back'
 ||x.status!=='failed'||x.healthResult!=='failed'||x.rollbackResult!=='restored'
 ||x.faultInjection!=='staging-health'||x.candidateRemoved!==true
 ||!Number.isSafeInteger(x.rollbackDurationMs)||x.rollbackDurationMs<0
 ||x.rollbackDurationMs>x.rollbackObjectiveSeconds*1000)process.exit(1);
NODE
        fault_unit_deadline=$((SECONDS + 30))
        while ssh "$SERVER" systemctl --user is-active --quiet "$UNIT" 2>/dev/null; do
          [ "$SECONDS" -lt "$fault_unit_deadline" ] || {
            echo "staging fault-drill transaction did not release its unit and mutex" >&2
            exit 1
          }
          sleep 1
        done
        rm -f -- "$STAGING_STATE" "$STAGING_STATE.next"
        TRANSACTION_ID="$(transaction_id)"
        TRANSACTION_SUFFIX="${TRANSACTION_ID##*-}"
        UNIT="nexus-release-staging-${RUNTIME_SHA:0:12}-${TRANSACTION_SUFFIX}"
      fi
      ssh "$SERVER" systemd-run --user --quiet --collect \
        --unit "$UNIT" \
        --property Type=oneshot \
        --property TimeoutStartSec=8min \
        ${FIRST_INSTALL_SETENV[@]+"${FIRST_INSTALL_SETENV[@]}"} \
        /bin/bash "$REMOTE_BUNDLE/scripts/remote-user-release-transaction.sh" \
        stage /home/dominguez/telegram-hub-bot-staging "$REMOTE_BUNDLE" "$RUNTIME_SHA" \
        "$ARTIFACT_DIGEST" "$TRANSACTION_ID" \
        "${NEXUS_RELEASE_STAGING_STABILITY_SECONDS:-15}" \
        "$EXPECTED_STAGING_PREDECESSOR_SHA" "$EXPECTED_STAGING_PREDECESSOR_DIGEST"
      poll_remote_transaction staging "$TRANSACTION_ID" "$STAGING_STATE"
    fi
    write_local_state staged "$STAGING_STATE"
    printf '{"ok":true,"phase":"staged","runtimeSha":"%s","artifactDigest":"%s","checkpointRun":%s,"ownerApprovalRequired":true}\n' \
      "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$CHECKPOINT_RUN"
    ;;

  promote)
    require_exact_checkout
    CHECKOUT_SHA="$RUNTIME_SHA"
    resolve_existing_state
    [ "$RUNTIME_SHA" = "$CHECKOUT_SHA" ] || {
      echo "prepared release state does not match the exact protected-main checkout" >&2
      exit 1
    }
    [ "$STATE_PHASE" = staged ] || {
      echo "exact release is not in the staged phase" >&2
      exit 1
    }
    [ "$CONFIRM" = "$RUNTIME_SHA:$ARTIFACT_DIGEST" ] || {
      echo "promotion requires --confirm $RUNTIME_SHA:$ARTIFACT_DIGEST" >&2
      exit 1
    }
    [ "${NEXUS_RELEASE_OWNER_AUTHORIZED:-0}" = 1 ] || {
      echo "promotion requires NEXUS_RELEASE_OWNER_AUTHORIZED=1" >&2
      exit 1
    }
    command -v gh >/dev/null || { echo "GitHub CLI is required" >&2; exit 1; }
    validate_checkpoint_run
    redownload_and_verify_manifest
    resolve_manifest_identity
    [ "$(sha256_file "$MANIFEST")" = "$MANIFEST_SHA256" ] || {
      echo "cached checkpoint manifest changed after revalidation" >&2
      exit 1
    }
    BUNDLE="$BUNDLE_ROOT/$RUNTIME_SHA/$ARTIFACT_DIGEST"
    STAGING_STATE="$TRANSACTION_ROOT/staging-$RUNTIME_SHA-$ARTIFACT_DIGEST.json"
    # --require-promotable rejects a first-install bootstrap receipt. That
    # transaction proved health, smoke, integrity, and soak, but it never proved
    # rollback, because the host it bootstrapped had nothing to roll back to.
    node scripts/release-checksum-manifest.mjs validate-state \
      --manifest "$MANIFEST" \
      --state "$STAGING_STATE" \
      --role staging \
      --require-promotable >/dev/null
    node scripts/release-checksum-manifest.mjs validate \
      --manifest "$MANIFEST" \
      --bundle "$BUNDLE" \
      --expect-source-sha "$RUNTIME_SHA" >/dev/null
    CHAT_PREFLIGHT="$(
      node --no-warnings scripts/release-checksum-manifest.mjs preflight-chat \
        --manifest "$MANIFEST" \
        --expect-manifest-sha256 "$MANIFEST_SHA256" \
        --expect-source-sha "$RUNTIME_SHA" \
        --expect-artifact-digest "$ARTIFACT_DIGEST"
    )"
    EXPECTED_PREDECESSOR_SHA="$(
      node -e '
const value=JSON.parse(process.argv[1]),sha=value?.releaseImpact?.deployedSha;
if(!/^[0-9a-f]{40}$/.test(sha||""))process.exit(1);
process.stdout.write(sha);' "$CHAT_PREFLIGHT"
    )"
    [ "$EXPECTED_PREDECESSOR_SHA" = "$CANONICAL_DEPLOYED_SHA" ] || {
      echo "promotion preflight predecessor does not match canonical release state" >&2
      exit 1
    }
    if [ "$DRY_RUN" = true ]; then
      printf '{"ok":true,"dryRun":true,"phase":"promote","runtimeSha":"%s","artifactDigest":"%s","server":"%s"}\n' \
        "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$SERVER"
      exit 0
    fi
    trap release_cleanup_all_locks EXIT
    release_acquire_local_lock "$ROOT" release
    RELEASE_NAME="${RUNTIME_SHA}-${ARTIFACT_DIGEST:0:12}"
    REMOTE_BUNDLE="/home/dominguez/.local/share/nexus-release/incoming/$RELEASE_NAME"
    PRODUCTION_STATE="$TRANSACTION_ROOT/production-$RUNTIME_SHA-$ARTIFACT_DIGEST.json"
    rm -f -- "$PRODUCTION_STATE" "$PRODUCTION_STATE.next"
    REMOTE_PRODUCTION_STATE="$(ssh "$SERVER" \
      cat /home/dominguez/.local/state/nexus-release/production.json 2>/dev/null || true)"
    RESUME_TRANSACTION_ID=""
    if [ -n "$REMOTE_PRODUCTION_STATE" ]; then
      set +e
      RESUME_TRANSACTION_ID="$(printf '%s' "$REMOTE_PRODUCTION_STATE" | node -e '
let body="";process.stdin.on("data",chunk=>body+=chunk);process.stdin.on("end",()=>{
 const x=JSON.parse(body),[sha,digest,predecessorSha,predecessorDigest]=process.argv.slice(1);
 if(x.schema!=="nexus.lean-release-transaction.v1"||x.role!=="production"
   ||x.runtimeSha!==sha||x.artifactDigest!==digest)process.exit(3);
 if(x.status==="passed"&&x.phase==="completed"){
   if(x.predecessorSha!==predecessorSha
     ||x.predecessorDigest!==predecessorDigest)process.exit(2);
   process.stdout.write(x.transactionId);process.exit(0);
 }
 if(x.status==="running"){process.stdout.write(x.transactionId);process.exit(4);}
 process.exit(2);
});' "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$EXPECTED_PREDECESSOR_SHA" \
        "$CANONICAL_DEPLOYED_DIGEST")"
      resume_status=$?
      set -e
      case "$resume_status" in
        0)
          printf '%s\n' "$REMOTE_PRODUCTION_STATE" > "$PRODUCTION_STATE"
          chmod 600 "$PRODUCTION_STATE"
          ;;
        4) poll_remote_transaction production "$RESUME_TRANSACTION_ID" "$PRODUCTION_STATE" ;;
        2)
          echo "the exact production transaction previously failed; inspect release:status before retrying" >&2
          exit 1
          ;;
        3) RESUME_TRANSACTION_ID="" ;;
        *) echo "remote production transaction state is invalid" >&2; exit 1 ;;
      esac
    fi
    if [ ! -f "$PRODUCTION_STATE" ]; then
      TRANSACTION_ID="$(transaction_id)"
      "$ROOT/scripts/promote-exact-release.sh" \
        "$SERVER" "$REMOTE_BUNDLE" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$TRANSACTION_ID" \
        "$MANIFEST" "$MANIFEST_SHA256" "$CANONICAL_DEPLOYED_DIGEST" \
        > "$PRODUCTION_STATE"
      chmod 600 "$PRODUCTION_STATE"
    else
      TRANSACTION_ID="$RESUME_TRANSACTION_ID"
    fi
    node - "$PRODUCTION_STATE" "$TRANSACTION_ID" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" <<'NODE'
const x=require(process.argv[2]);
const [id,sha,digest]=process.argv.slice(3);
if(x.schema!=='nexus.lean-release-transaction.v1'||x.phase!=='completed'||x.status!=='passed'
 ||x.transactionId!==id||x.runtimeSha!==sha||x.artifactDigest!==digest)process.exit(1);
NODE
    node scripts/release-checksum-manifest.mjs validate-state \
      --manifest "$MANIFEST" \
      --state "$PRODUCTION_STATE" \
      --role production >/dev/null
    write_local_state completed "$STAGING_STATE" "$PRODUCTION_STATE"
    cat "$PRODUCTION_STATE"
    ;;
esac
