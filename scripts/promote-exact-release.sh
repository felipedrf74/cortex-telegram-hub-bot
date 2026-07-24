#!/usr/bin/env bash
# Promote the exact dependency-prepared staging release to production.
# Production mutation is owner-gated by release-operator.sh; this helper never
# builds, installs dependencies, or copies the local repository to production.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/lib/release-gates.sh"
SERVER="${1:?server is required}"
STAGING_BASE="${2:?staging base is required}"
PROD_BASE="${3:?production base is required}"
RUNTIME_SHA="${4:?runtime SHA is required}"
ARTIFACT_DIGEST="${5:?artifact digest is required}"
TARGET_VERSION="${6:?target version is required}"
INSTALLED_RUNTIME_DIGEST="${7:?installed runtime digest is required}"
RECOVERY_RUNTIME_DIGEST="${8:?recovery runtime digest is required}"
RELEASE_MANIFEST="${9:?signed release manifest is required}"
STAGING_ATTESTATION="${10:?signed staging attestation is required}"
PUBLIC_BASE_URL="${NEXUS_PRODUCTION_PUBLIC_BASE_URL:-https://api.nexushub.me}"

[[ "$SERVER" =~ ^[A-Za-z0-9._@-]+$ ]] || { echo "invalid deploy server" >&2; exit 64; }
[ "$STAGING_BASE" = /srv/nexus-release/staging ] || { echo "unsafe staging base" >&2; exit 64; }
[ "$PROD_BASE" = /srv/nexus-release/production ] || { echo "unsafe production base" >&2; exit 64; }
[[ "$RUNTIME_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid runtime SHA" >&2; exit 64; }
[[ "$ARTIFACT_DIGEST" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid artifact digest" >&2; exit 64; }
[[ "$TARGET_VERSION" =~ ^[0-9A-Za-z.+-]+$ ]] || { echo "invalid target version" >&2; exit 64; }
[[ "$INSTALLED_RUNTIME_DIGEST" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid installed runtime digest" >&2; exit 64; }
[[ "$RECOVERY_RUNTIME_DIGEST" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid recovery runtime digest" >&2; exit 64; }
[[ "$PUBLIC_BASE_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || { echo "invalid production public base URL" >&2; exit 64; }
[ "${NEXUS_RELEASE_OWNER_AUTHORIZED:-0}" = "1" ] || {
  echo "exact promotion requires explicit owner authorization" >&2
  exit 1
}
release_require_git_worktree "$ROOT"
if ! release_require_clean_tree "$ROOT"; then
  echo "exact promotion requires a clean checkout" >&2
  exit 1
fi
[ "$(git -C "$ROOT" rev-parse HEAD)" = "$RUNTIME_SHA" ] || {
  echo "exact promotion checkout SHA does not match the signed runtime SHA" >&2
  exit 1
}
IFS=$'\t' read -r RELEASE_MANIFEST_SHA256 STAGING_ATTESTATION_SHA256 < <(node - \
  "$RELEASE_MANIFEST" "$STAGING_ATTESTATION" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" \
  "$INSTALLED_RUNTIME_DIGEST" "$RECOVERY_RUNTIME_DIGEST" <<'NODE'
const crypto=require('crypto');const fs=require('fs');const path=require('path');
const [manifestPath,stagingPath,runtimeSha,artifactDigest,installedDigest,recoveryDigest]=process.argv.slice(2);
const digest=(body)=>crypto.createHash('sha256').update(body).digest('hex');
const read=(file,label)=>{
 if(!path.isAbsolute(file)||fs.realpathSync(file)!==file)throw new Error(`${label} path is not canonical`);
 const stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size===0||stat.size>16*1024*1024)throw new Error(`${label} is unsafe`);
 return fs.readFileSync(file);
};
const manifestBody=read(manifestPath,'release manifest'),stagingBody=read(stagingPath,'staging attestation');
const manifest=JSON.parse(manifestBody),staging=JSON.parse(stagingBody);
if(manifest?.schema!=='nexus.release-manifest.v2'||manifest?.payload?.runtimeSha!==runtimeSha
 ||manifest?.payload?.artifact?.digest!==artifactDigest
 ||staging?.schema!=='nexus.staging-attestation.v1'||staging?.payload?.runtimeSha!==runtimeSha
 ||staging?.payload?.artifactDigest!==artifactDigest
 ||staging?.payload?.installedRuntimeDigest!==installedDigest
 ||staging?.payload?.recoveryRuntimeDigest!==recoveryDigest
 ||staging?.payload?.releaseManifestSha256!==digest(manifestBody))process.exit(1);
process.stdout.write(`${digest(manifestBody)}\t${digest(stagingBody)}\n`);
NODE
) || { echo "signed release recovery evidence identity is invalid" >&2; exit 1; }
[[ "$RELEASE_MANIFEST_SHA256" =~ ^[a-f0-9]{64}$ \
    && "$STAGING_ATTESTATION_SHA256" =~ ^[a-f0-9]{64}$ ]] || {
  echo "signed release recovery evidence digest is invalid" >&2
  exit 1
}
node "$ROOT/scripts/rollback-drill-check.mjs" validate \
  --root "$ROOT" \
  --release-gate \
  --max-age-days 30 \
  --json >/dev/null

# Serialize exact promotion and emergency-recovery operator paths through the
# same lock name.
# The remote lock is the cross-worktree/cross-operator authority; the local
# lock prevents accidental duplicate invocation from this checkout.
trap release_cleanup_all_locks EXIT
release_acquire_local_lock "$ROOT" "prod-deploy"
release_acquire_remote_lock "$SERVER" "$PROD_BASE" "prod-deploy"

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3)
SYSTEMD_CONTROL="${NEXUS_RELEASE_SYSTEMD_CONTROL:-/usr/local/sbin/nexus-release-promotion-control}"
SYSTEMD_TRANSACTION_AVAILABLE=false
set +e
SYSTEMD_CONTROL_VERSION="$("${SSH[@]}" "$SERVER" sudo -n "$SYSTEMD_CONTROL" version 2>/dev/null)"
SYSTEMD_CONTROL_EXIT=$?
set -e
if [ "$SYSTEMD_CONTROL_EXIT" -eq 0 ] && [ "$SYSTEMD_CONTROL_VERSION" = nexus-release-promotion-control.v3 ]; then
  SYSTEMD_TRANSACTION_AVAILABLE=true
  OWNER_PRIVATE_KEY="${NEXUS_RELEASE_OWNER_PRIVATE_KEY_PATH:-}"
  [ -n "$OWNER_PRIVATE_KEY" ] && [ -f "$OWNER_PRIVATE_KEY" ] && [ ! -L "$OWNER_PRIVATE_KEY" ] || {
    echo "v3 promotion requires the owner's off-server Ed25519 private key" >&2
    exit 77
  }
  owner_key_mode="$(stat -c '%a' "$OWNER_PRIVATE_KEY" 2>/dev/null || stat -f '%Lp' "$OWNER_PRIVATE_KEY")"
  case "$owner_key_mode" in 400|600) ;; *) echo "owner promotion private key mode must be 400 or 600" >&2; exit 77 ;; esac
else
  echo "root-owned promotion transaction is not provisioned; the legacy local transaction is retired" >&2
  exit 1
fi

RELEASE_NAME="${RUNTIME_SHA}-${ARTIFACT_DIGEST:0:12}"
STAGING_RELEASE="$STAGING_BASE/releases/$RELEASE_NAME"
PROD_RELEASE="$PROD_BASE/releases/$RELEASE_NAME"
BACKUP_DIR="/home/dominguez/backups/nexushub"
PROMOTION_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TRANSACTION_CHECKPOINT_DIR="$ROOT/.local/release/transactions"
TRANSACTION_CHECKPOINT="$TRANSACTION_CHECKPOINT_DIR/${RUNTIME_SHA}-${ARTIFACT_DIGEST}.checkpoint.json"
TRANSACTION_CHECKPOINT_EXISTS=false
RESUME_EXISTING_TRANSACTION=false
RESUME_SIGNED_REQUEST_PENDING=false
RESUME_STATUS_JSON=""
RESUME_REQUEST_SHA=""
RESUME_REQUEST_EXPIRES_AT=""
RETRY_TERMINAL_PREDECESSOR=false
RETRY_PREDECESSOR_RUNTIME=""
RETRY_PREDECESSOR_SHA=""
RETRY_PREDECESSOR_ARTIFACT_DIGEST=""
RETRY_PREDECESSOR_INSTALLED_RUNTIME_DIGEST=""
RETIRED_UNSIGNED_TRANSACTION_ID=""

# `.local` is intentionally ignored by Git, so validate and create each
# checkpoint parent one level at a time before reading or writing authority.
# Never let install/mkdir follow an attacker-controlled parent symlink.
for local_authority_directory in \
  "$ROOT/.local" \
  "$ROOT/.local/release" \
  "$TRANSACTION_CHECKPOINT_DIR"; do
  if [ -e "$local_authority_directory" ] || [ -L "$local_authority_directory" ]; then
    [ -d "$local_authority_directory" ] && [ ! -L "$local_authority_directory" ] || {
      echo "local promotion authority directory is unsafe: $local_authority_directory" >&2
      exit 1
    }
  else
    mkdir "$local_authority_directory"
  fi
  chmod 700 "$local_authority_directory"
done

fsync_local_directory() {
  local directory="$1"
  [ -d "$directory" ] && [ ! -L "$directory" ] || {
    echo "local release durability directory is unsafe: $directory" >&2
    return 1
  }
  node - "$directory" <<'NODE'
const fs=require('fs');const directory=process.argv[2];
const stat=fs.lstatSync(directory);
if(!stat.isDirectory()||stat.isSymbolicLink())process.exit(1);
const descriptor=fs.openSync(directory,'r');
try{fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
NODE
}
fsync_local_directory "$ROOT"
fsync_local_directory "$ROOT/.local"
fsync_local_directory "$ROOT/.local/release"
fsync_local_directory "$TRANSACTION_CHECKPOINT_DIR"

reconcile_local_link_publication() {
  local output="$1"
  [ -e "$output" ] || [ -L "$output" ] || return 0
  node - "$output" <<'NODE'
const fs=require('fs');const path=require('path');
const output=process.argv[2],parent=path.dirname(output);
const prefix=`.${path.basename(output)}.next.`;
const parentStat=fs.lstatSync(parent),stat=fs.lstatSync(output);
if(!parentStat.isDirectory()||parentStat.isSymbolicLink()
  ||path.dirname(path.resolve(output))!==path.resolve(parent)
  ||!stat.isFile()||stat.isSymbolicLink()
  ||![0o400,0o600].includes(stat.mode&0o777))process.exit(1);
if(stat.nlink>1){
 let removed=false;
 for(const name of fs.readdirSync(parent)){
  if(!name.startsWith(prefix))continue;
  const candidate=path.join(parent,name),candidateStat=fs.lstatSync(candidate);
  if(!candidateStat.isFile()||candidateStat.isSymbolicLink()
    ||candidateStat.dev!==stat.dev||candidateStat.ino!==stat.ino)continue;
  fs.unlinkSync(candidate);
  removed=true;
 }
 if(removed){
  const descriptor=fs.openSync(parent,'r');
  try{fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
 }
}
if(fs.lstatSync(output).nlink!==1)process.exit(1);
NODE
}

cleanup_retired_unsigned_request() {
  local transaction_id="$1"
  local archive_dir="$TRANSACTION_CHECKPOINT_DIR/expired-unsigned-authority"
  local archive="$archive_dir/${transaction_id}.json"
  local request="$TRANSACTION_CHECKPOINT_DIR/${transaction_id}.request.json"
  [[ "$transaction_id" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+-[a-f0-9]{12}$ ]] || {
    echo "retired unsigned promotion transaction ID is invalid" >&2
    return 1
  }
  [ -d "$archive_dir" ] && [ ! -L "$archive_dir" ] \
    && [ -f "$archive" ] && [ ! -L "$archive" ] || {
    echo "retired unsigned promotion authority archive is unavailable" >&2
    return 1
  }
  node - "$archive" "$request" "$transaction_id" "$TRANSACTION_CHECKPOINT_DIR" <<'NODE'
const crypto=require('crypto');const fs=require('fs');const path=require('path');
const [archivePath,requestPath,id,root]=process.argv.slice(2);
const archiveStat=fs.lstatSync(archivePath);
if(!archiveStat.isFile()||archiveStat.isSymbolicLink()||archiveStat.nlink!==1
  ||(archiveStat.mode&0o777)!==0o600||path.dirname(archivePath)!==path.join(root,'expired-unsigned-authority')
  ||requestPath!==path.join(root,`${id}.request.json`))process.exit(1);
const archive=JSON.parse(fs.readFileSync(archivePath,'utf8')),request=archive.unsignedRequest;
if(archive.schema!=='nexus.expired-unsigned-promotion-authority.v1'
  ||archive.transactionId!==id||archive.reason!=='expired_unsigned_request_server_not_found'
  ||request?.sha256!==crypto.createHash('sha256').update(Buffer.from(request?.bodyBase64||'','base64')).digest('hex')
  ||Buffer.from(request?.bodyBase64||'','base64').toString('base64')!==request?.bodyBase64)process.exit(1);
let stat=null;
try{stat=fs.lstatSync(requestPath);}catch(error){if(error?.code!=='ENOENT')throw error;}
if(stat!==null){
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1
    ||![0o400,0o600].includes(stat.mode&0o777))process.exit(1);
  const body=fs.readFileSync(requestPath);
  if(body.toString('base64')!==request.bodyBase64
    ||crypto.createHash('sha256').update(body).digest('hex')!==request.sha256)process.exit(1);
  fs.unlinkSync(requestPath);
  const descriptor=fs.openSync(root,'r');
  try{fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
}
NODE
}

# A retry may arrive after the root-owned transaction completed but before the
# Mac wrote local production evidence. Recover the exact signed transaction
# authority before deriving a live predecessor or preparing any release path.
if [ ! -e "$TRANSACTION_CHECKPOINT" ] && [ ! -L "$TRANSACTION_CHECKPOINT" ] \
    && { [ -e "$TRANSACTION_CHECKPOINT.next" ] || [ -L "$TRANSACTION_CHECKPOINT.next" ]; }; then
  [ -f "$TRANSACTION_CHECKPOINT.next" ] && [ ! -L "$TRANSACTION_CHECKPOINT.next" ] \
    && [ "$(stat -c '%a' "$TRANSACTION_CHECKPOINT.next" 2>/dev/null \
      || stat -f '%Lp' "$TRANSACTION_CHECKPOINT.next")" = 600 ] || {
    echo "orphaned local promotion checkpoint is unsafe" >&2
    exit 1
  }
  mv "$TRANSACTION_CHECKPOINT.next" "$TRANSACTION_CHECKPOINT"
  fsync_local_directory "$TRANSACTION_CHECKPOINT_DIR"
fi
if [ -f "$TRANSACTION_CHECKPOINT" ]; then
  [ ! -L "$TRANSACTION_CHECKPOINT" ] || { echo "local promotion checkpoint must not be a symlink" >&2; exit 1; }
  checkpoint_mode="$(stat -c '%a' "$TRANSACTION_CHECKPOINT" 2>/dev/null || stat -f '%Lp' "$TRANSACTION_CHECKPOINT")"
  case "$checkpoint_mode" in 400|600) ;; *) echo "local promotion checkpoint mode must be 400 or 600" >&2; exit 1 ;; esac
  CHECKPOINT_FIELDS="$(node - "$TRANSACTION_CHECKPOINT" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" \
    "$INSTALLED_RUNTIME_DIGEST" "$RECOVERY_RUNTIME_DIGEST" "$RELEASE_MANIFEST_SHA256" \
    "$STAGING_ATTESTATION_SHA256" "$TARGET_VERSION" "$SERVER" "$PROD_BASE" <<'NODE'
const fs = require('fs');
const [file, runtimeSha, artifactDigest, installedRuntimeDigest, recoveryRuntimeDigest,
  releaseManifestSha256, stagingAttestationSha256, targetVersion, server, productionBase] = process.argv.slice(2);
const x = JSON.parse(fs.readFileSync(file, 'utf8'));
if (x.schema !== 'nexus.promotion-client-checkpoint.v1' || x.runtimeSha !== runtimeSha
    || x.artifactDigest !== artifactDigest || x.installedRuntimeDigest !== installedRuntimeDigest
    || x.recoveryRuntimeDigest !== recoveryRuntimeDigest
    || x.releaseManifestSha256 !== releaseManifestSha256
    || x.stagingAttestationSha256 !== stagingAttestationSha256
    || x.targetVersion !== targetVersion || x.server !== server || x.productionBase !== productionBase
    || !/^[0-9]{8}T[0-9]{6}Z-[0-9]+-[a-f0-9]{12}$/u.test(x.transactionId || '')
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(x.startedAt || '')) process.exit(1);
const retired=x.retiredUnsignedTransactionId??null;
if(retired!==null&&(!/^[0-9]{8}T[0-9]{6}Z-[0-9]+-[a-f0-9]{12}$/u.test(retired)
  ||retired===x.transactionId))process.exit(1);
process.stdout.write(`${x.transactionId}\t${x.startedAt}\t${retired??'-'}\n`);
NODE
  )" || { echo "local promotion checkpoint identity is invalid" >&2; exit 1; }
  IFS=$'\t' read -r PROMOTION_RUN_ID PROMOTION_STARTED_AT RETIRED_UNSIGNED_TRANSACTION_ID \
    <<<"$CHECKPOINT_FIELDS" || {
    echo "local promotion checkpoint fields are invalid" >&2
    exit 1
  }
  if [ "$RETIRED_UNSIGNED_TRANSACTION_ID" = "-" ]; then
    RETIRED_UNSIGNED_TRANSACTION_ID=""
  else
    cleanup_retired_unsigned_request "$RETIRED_UNSIGNED_TRANSACTION_ID"
  fi
  TRANSACTION_CHECKPOINT_EXISTS=true
  signed_resume_request="$TRANSACTION_CHECKPOINT_DIR/${PROMOTION_RUN_ID}.request.envelope.json"
  if [ -e "$signed_resume_request" ] || [ -L "$signed_resume_request" ]; then
    reconcile_local_link_publication "$signed_resume_request" || {
      echo "signed promotion resume request publication is unsafe" >&2
      exit 1
    }
    [ "$SYSTEMD_TRANSACTION_AVAILABLE" = true ] || {
      echo "signed promotion checkpoint requires the root-owned transaction control" >&2
      exit 1
    }
    [ -f "$signed_resume_request" ] && [ ! -L "$signed_resume_request" ] || {
      echo "signed promotion resume request is unsafe" >&2
      exit 1
    }
    signed_request_mode="$(stat -c '%a' "$signed_resume_request" 2>/dev/null || stat -f '%Lp' "$signed_resume_request")"
    case "$signed_request_mode" in 400|600) ;; *) echo "signed promotion resume request mode must be 400 or 600" >&2; exit 1 ;; esac
    IFS=$'\t' read -r RESUME_REQUEST_SHA RESUME_REQUEST_EXPIRES_AT < <(node - \
      "$signed_resume_request" "$OWNER_PRIVATE_KEY" "$PROMOTION_RUN_ID" \
      "$PROD_BASE" "$PROD_RELEASE" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" \
      "$INSTALLED_RUNTIME_DIGEST" "$RECOVERY_RUNTIME_DIGEST" "$RELEASE_MANIFEST_SHA256" \
      "$STAGING_ATTESTATION_SHA256" "$TARGET_VERSION" <<'NODE'
const crypto = require('crypto');
const fs = require('fs');
const [envelopePath, privateKeyPath, transactionId, productionBase, targetRuntime,
  runtimeSha, artifactDigest, installedRuntimeDigest, recoveryRuntimeDigest,
  releaseManifestSha256, stagingAttestationSha256, targetVersion] = process.argv.slice(2);
const canonicalJson = (input) => {
  if (input === null || typeof input !== 'object') return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key])}`).join(',')}}`;
};
const envelope = JSON.parse(fs.readFileSync(envelopePath, 'utf8'));
const payload = envelope?.payload;
if (envelope?.schema !== 'nexus.promotion-transaction-request-envelope.v1'
    || envelope?.keyId !== 'nexus-owner-promotion-2026'
    || envelope?.signatureAlgorithm !== 'ed25519'
    || payload?.schema !== 'nexus.promotion-transaction-request.v1'
    || payload?.transactionId !== transactionId
    || payload?.ownerAuthorization !== 'explicit'
    || payload?.productionBase !== productionBase
    || payload?.target?.runtime !== targetRuntime
    || payload?.target?.sha !== runtimeSha
    || payload?.target?.sentryRelease !== runtimeSha
    || payload?.target?.artifactDigest !== artifactDigest
    || payload?.target?.installedRuntimeDigest !== installedRuntimeDigest
    || payload?.target?.recoveryRuntimeDigest !== recoveryRuntimeDigest
    || payload?.releaseEvidence?.releaseManifestSha256 !== releaseManifestSha256
    || payload?.releaseEvidence?.stagingAttestationSha256 !== stagingAttestationSha256
    || payload?.target?.version !== targetVersion) process.exit(1);
const createdAt=Date.parse(payload.createdAt||''),expiresAt=Date.parse(payload.expiresAt||'');
if(!Number.isFinite(createdAt)||!Number.isFinite(expiresAt)
    ||expiresAt<=createdAt||expiresAt-createdAt>30*60*1000)process.exit(1);
const privateKey = crypto.createPrivateKey(fs.readFileSync(privateKeyPath, 'utf8'));
const valid = crypto.verify(
  null,
  Buffer.from(canonicalJson(payload)),
  crypto.createPublicKey(privateKey),
  Buffer.from(envelope.signature || '', 'base64'),
);
if (!valid) process.exit(1);
process.stdout.write(`${crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex')}\t${payload.expiresAt}\n`);
NODE
    ) || { echo "signed promotion resume request identity is invalid" >&2; exit 1; }
    [[ "$RESUME_REQUEST_SHA" =~ ^[a-f0-9]{64}$ ]] || {
      echo "signed promotion resume request digest is invalid" >&2
      exit 1
    }
    [[ "$RESUME_REQUEST_EXPIRES_AT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]] || {
      echo "signed promotion resume request expiration is invalid" >&2
      exit 1
    }
    set +e
    RESUME_STATUS_JSON="$("${SSH[@]}" "$SERVER" sudo -n "$SYSTEMD_CONTROL" status "$PROMOTION_RUN_ID" 2>/dev/null)"
    resume_status_exit=$?
    set -e
    if [ "$resume_status_exit" -eq 66 ]; then
      printf '%s' "$RESUME_STATUS_JSON" | node -e '
        let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
          const x=JSON.parse(b);
          if(x.schema!=="nexus.promotion-transaction-status.v1"
            ||x.transactionId!==process.argv[1]||x.status!=="not_found")process.exit(1);
        });' "$PROMOTION_RUN_ID" || {
        echo "authoritative promotion not-found response is invalid" >&2
        exit 1
      }
      RESUME_SIGNED_REQUEST_PENDING=true
      RESUME_STATUS_JSON=""
    elif [ "$resume_status_exit" -eq 0 ]; then
      read -r resume_phase resume_status < <(printf '%s' "$RESUME_STATUS_JSON" | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const x=JSON.parse(b),id=process.argv[1],digest=process.argv[2];
        const statuses=new Set(["pending","running","recovery_required","escrow_pending",
          "completed","recovered","failed_before_stop","recovery_failed"]);
        if(x.schema!=="nexus.promotion-transaction-journal.v1"||x.transactionId!==id
          ||x.requestSha256!==digest||typeof x.phase!=="string"||!statuses.has(x.status))process.exit(1);
        process.stdout.write(`${x.phase} ${x.status}\n`);
      });' "$PROMOTION_RUN_ID" "$RESUME_REQUEST_SHA") || {
        echo "authoritative promotion resume status is invalid" >&2
        exit 1
      }
      if [ "$resume_status" = failed_before_stop ] || [ "$resume_status" = recovered ]; then
        IFS=$'\t' read -r RETRY_PREDECESSOR_RUNTIME RETRY_PREDECESSOR_SHA \
          RETRY_PREDECESSOR_ARTIFACT_DIGEST RETRY_PREDECESSOR_INSTALLED_RUNTIME_DIGEST \
          < <(printf '%s' "$RESUME_STATUS_JSON" | node -e '
          let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
            const x=JSON.parse(b),id=process.argv[1],requestSha=process.argv[2],
              prod=process.argv[3],targetRuntime=process.argv[4],targetSha=process.argv[5],
              artifact=process.argv[6],installed=process.argv[7],recovery=process.argv[8];
            const p=x.predecessor,t=x.target;
            const failedBeforeStop=x.status==="failed_before_stop"
              &&["preflight","failed_before_stop"].includes(x.phase)
              &&x.recoveryArmed===false&&x.escrowConfirmed===false&&x.recovery===null;
            const recovered=x.status==="recovered"&&x.phase==="recovery_complete"
              &&x.recovery?.schema==="nexus.promotion-recovery-result.v1"
              &&x.recovery?.targetMet===true
              &&Number.isSafeInteger(x.recovery?.outageToHealthySeconds)
              &&x.recovery.outageToHealthySeconds<=120;
            if(x.schema!=="nexus.promotion-transaction-journal.v1"
              ||x.transactionId!==id||x.requestSha256!==requestSha
              ||(!failedBeforeStop&&!recovered)
              ||!Number.isFinite(Date.parse(x.completedAt||""))
              ||t?.runtime!==targetRuntime||t?.sha!==targetSha
              ||t?.artifactDigest!==artifact||t?.installedRuntimeDigest!==installed
              ||t?.recoveryRuntimeDigest!==recovery
              ||typeof p?.runtime!=="string"
              ||!(p.runtime===prod||p.runtime.startsWith(`${prod}/releases/`))
              ||!/^[a-f0-9]{40}$/u.test(p?.sha||"")
              ||!/^[a-f0-9]{64}$/u.test(p?.artifactDigest||"")
              ||!/^[a-f0-9]{64}$/u.test(p?.installedRuntimeDigest||""))process.exit(1);
            process.stdout.write(`${p.runtime}\t${p.sha}\t${p.artifactDigest}\t${p.installedRuntimeDigest}\n`);
          });' "$PROMOTION_RUN_ID" "$RESUME_REQUEST_SHA" "$PROD_BASE" "$PROD_RELEASE" \
          "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$INSTALLED_RUNTIME_DIGEST" \
          "$RECOVERY_RUNTIME_DIGEST") || {
          echo "terminal predecessor retry evidence is invalid" >&2
          exit 1
        }
        # Re-prove that the exact predecessor named by the terminal journal is
        # still the healthy live runtime before issuing fresh owner authority.
        "${SSH[@]}" "$SERVER" bash -s -- "$PROD_BASE" "$RETRY_PREDECESSOR_RUNTIME" \
          "$RETRY_PREDECESSOR_SHA" "$RETRY_PREDECESSOR_ARTIFACT_DIGEST" \
          "$RETRY_PREDECESSOR_INSTALLED_RUNTIME_DIGEST" <<'REMOTE_FAILED_BEFORE_STOP_IDENTITY'
set -euo pipefail
base="$1"; predecessor="$2"; expected_sha="$3"; expected_artifact="$4"; expected_installed="$5"
current="$base"
if [ -L "$base/current" ]; then current="$(readlink -f "$base/current")"; fi
[ "$current" = "$predecessor" ] || { echo "terminal transaction predecessor is no longer current" >&2; exit 1; }
pm2_bin=""
for candidate in "$(command -v pm2 2>/dev/null || true)" /usr/local/bin/pm2 "$HOME/.npm-global/bin/pm2"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then pm2_bin="$candidate"; break; fi
done
[ -n "$pm2_bin" ] || { echo "PM2 is unavailable for pre-mutation retry verification" >&2; exit 1; }
if [ "$predecessor" != "$base" ]; then
  [ -f "$predecessor/.complete.json" ] \
    && [ -f "$predecessor/.nexus-installed-runtime.json" ] \
    && node -e '
      const complete=require(process.argv[1]),installed=require(process.argv[2]);
      if(complete.runtimeSha!==process.argv[3]||complete.artifactDigest!==process.argv[4]
        ||installed.aggregateDigest!==process.argv[5])process.exit(1);
    ' "$predecessor/.complete.json" "$predecessor/.nexus-installed-runtime.json" \
      "$expected_sha" "$expected_artifact" "$expected_installed"
fi
timeout 5s "$pm2_bin" jlist | node -e '
const fs=require("fs"),rows=JSON.parse(fs.readFileSync(0,"utf8"));
const root=process.argv[1],sha=process.argv[2];
for(const [name,cwd] of [["nexus-hub",root],["content-engine",`${root}/content-engine`]]){
 const row=rows.find((entry)=>entry?.name===name),env=row?.pm2_env??{};
 const observed=env.NEXUS_RELEASE_SHA||env.GIT_COMMIT||"";
 if(env.status!=="online"||env.pm_cwd!==cwd||(sha&&observed!==sha))process.exit(1);
}' "$predecessor" "$expected_sha"
REMOTE_FAILED_BEFORE_STOP_IDENTITY

        retry_archive_dir="$TRANSACTION_CHECKPOINT_DIR/terminal-retries"
        if [ -e "$retry_archive_dir" ] || [ -L "$retry_archive_dir" ]; then
          [ -d "$retry_archive_dir" ] && [ ! -L "$retry_archive_dir" ] || {
            echo "terminal promotion archive directory is unsafe" >&2
            exit 1
          }
        else
          mkdir "$retry_archive_dir"
        fi
        chmod 700 "$retry_archive_dir"
        retry_archive="$retry_archive_dir/${PROMOTION_RUN_ID}.json"
        raw_resume_request="$TRANSACTION_CHECKPOINT_DIR/${PROMOTION_RUN_ID}.request.json"
        node - "$retry_archive" "$TRANSACTION_CHECKPOINT" "$signed_resume_request" \
          "$raw_resume_request" "$RESUME_STATUS_JSON" <<'NODE'
const crypto=require('crypto'),fs=require('fs'),path=require('path');
const [output,checkpoint,envelope,request,statusRaw]=process.argv.slice(2);
const digest=(file)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
for(const file of [checkpoint,envelope,request]){
 const stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)process.exit(1);
}
const status=JSON.parse(statusRaw);
const checkpointBytes=fs.readFileSync(checkpoint);
const body=Buffer.from(`${JSON.stringify({
 schema:'nexus.terminal-promotion-client-archive.v1',
 transactionId:status.transactionId,requestSha256:status.requestSha256,
 terminalStatus:status,archivedAt:status.completedAt,
 clientCheckpoint:{sha256:digest(checkpoint),bodyBase64:checkpointBytes.toString('base64')},
 signedRequestEnvelope:{path:envelope,sha256:digest(envelope)},
 rawRequest:{path:request,sha256:digest(request)},
},null,2)}\n`);
const parent=path.dirname(output),prefix=`.${path.basename(output)}.next.`;
const parentStat=fs.lstatSync(parent);
if(!parentStat.isDirectory()||parentStat.isSymbolicLink()
  ||(parentStat.mode&0o777)!==0o700
  ||path.dirname(path.resolve(output))!==path.resolve(parent))process.exit(1);
const lstat=(file)=>{
 try{return fs.lstatSync(file);}
 catch(error){if(error?.code==='ENOENT')return null;throw error;}
};
const fsyncParent=()=>{
 const descriptor=fs.openSync(parent,'r');
 try{fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
};
const validateExisting=()=>{
 let stat=lstat(output);
 if(!stat||!stat.isFile()||stat.isSymbolicLink()
   ||(stat.mode&0o777)!==0o600||!fs.readFileSync(output).equals(body))process.exit(1);
 if(stat.nlink>1){
  let removed=false;
  for(const name of fs.readdirSync(parent)){
   if(!name.startsWith(prefix))continue;
   const candidate=path.join(parent,name),candidateStat=lstat(candidate);
   if(!candidateStat||!candidateStat.isFile()||candidateStat.isSymbolicLink()
     ||candidateStat.dev!==stat.dev||candidateStat.ino!==stat.ino
     ||!fs.readFileSync(candidate).equals(body))continue;
   fs.unlinkSync(candidate);
   removed=true;
  }
  if(removed)fsyncParent();
  stat=fs.lstatSync(output);
 }
 if(stat.nlink!==1)process.exit(1);
};
if(lstat(output))validateExisting();
else{
 const temporary=path.join(parent,
   `${prefix}${process.pid}.${crypto.randomBytes(12).toString('hex')}`);
 let descriptor;
 try{
  descriptor=fs.openSync(temporary,'wx',0o600);
  try{fs.writeFileSync(descriptor,body);fs.fsyncSync(descriptor);}
  finally{fs.closeSync(descriptor);descriptor=undefined;}
  try{fs.linkSync(temporary,output);fsyncParent();}
  catch(error){if(error?.code!=='EEXIST')throw error;validateExisting();}
  fs.unlinkSync(temporary);
  fsyncParent();
 validateExisting();
 }finally{if(descriptor!==undefined)fs.closeSync(descriptor);}
}
NODE
        fsync_local_directory "$retry_archive_dir"
        fsync_local_directory "$TRANSACTION_CHECKPOINT_DIR"
        RETRY_TERMINAL_PREDECESSOR=true
        TRANSACTION_CHECKPOINT_EXISTS=false
        RESUME_STATUS_JSON=""
        RESUME_REQUEST_SHA=""
        RESUME_REQUEST_EXPIRES_AT=""
        PROMOTION_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      else
        RESUME_EXISTING_TRANSACTION=true
        case "$resume_status" in
          pending|running|recovery_required)
            "${SSH[@]}" "$SERVER" sudo -n "$SYSTEMD_CONTROL" ensure-started \
              "$PROMOTION_RUN_ID" "$RESUME_REQUEST_SHA" >/dev/null
            ;;
        esac
      fi
    else
      echo "unable to reconcile the existing root-owned promotion transaction: $PROMOTION_RUN_ID" >&2
      exit 75
    fi
  else
    unsigned_resume_request="$TRANSACTION_CHECKPOINT_DIR/${PROMOTION_RUN_ID}.request.json"
    reconcile_local_link_publication "$unsigned_resume_request" || {
      echo "unsigned promotion resume request publication is unsafe" >&2
      exit 1
    }
    if [ -e "$unsigned_resume_request" ] || [ -L "$unsigned_resume_request" ]; then
      [ "$SYSTEMD_TRANSACTION_AVAILABLE" = true ] || {
        echo "unsigned promotion checkpoint requires the root-owned transaction control" >&2
        exit 1
      }
      [ -f "$unsigned_resume_request" ] && [ ! -L "$unsigned_resume_request" ] || {
        echo "unsigned promotion resume request is unsafe" >&2
        exit 1
      }
      unsigned_request_mode="$(stat -c '%a' "$unsigned_resume_request" 2>/dev/null \
        || stat -f '%Lp' "$unsigned_resume_request")"
      case "$unsigned_request_mode" in
        400|600) ;;
        *) echo "unsigned promotion resume request mode must be 400 or 600" >&2; exit 1 ;;
      esac
      UNSIGNED_REQUEST_FIELDS="$(node - "$unsigned_resume_request" "$PROMOTION_RUN_ID" \
        "$PROD_BASE" "$PROD_RELEASE" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" \
        "$INSTALLED_RUNTIME_DIGEST" "$RECOVERY_RUNTIME_DIGEST" \
        "$RELEASE_MANIFEST_SHA256" "$STAGING_ATTESTATION_SHA256" "$TARGET_VERSION" <<'NODE'
const fs=require('fs');
const [file,id,productionBase,targetRuntime,runtimeSha,artifactDigest,installedDigest,
 recoveryDigest,manifestSha,stagingSha,targetVersion]=process.argv.slice(2);
const stat=fs.lstatSync(file);
const request=JSON.parse(fs.readFileSync(file,'utf8'));
const record=(value)=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>record(value)&&Object.keys(value).length===keys.length
 &&keys.every((key)=>Object.prototype.hasOwnProperty.call(value,key));
if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size===0||stat.size>16*1024*1024
 ||!exact(request,['schema','transactionId','createdAt','expiresAt','ownerAuthorization',
   'productionBase','predecessor','target','releaseEvidence','backupDir','preparedRuntimeDir',
   'pm2Bin','publicBaseUrl','stabilitySeconds','gateTimeoutSeconds','migration'])
 ||!exact(request.predecessor,['runtime','sha','artifactDigest','installedRuntimeDigest'])
 ||!exact(request.target,['runtime','sha','sentryRelease','artifactDigest',
   'installedRuntimeDigest','recoveryRuntimeDigest','version'])
 ||!exact(request.releaseEvidence,['releaseManifestBase64','releaseManifestSha256',
   'stagingAttestationBase64','stagingAttestationSha256'])
 ||request.schema!=='nexus.promotion-transaction-request.v1'||request.transactionId!==id
 ||request.ownerAuthorization!=='explicit'||request.productionBase!==productionBase
 ||request.target.runtime!==targetRuntime||request.target.sha!==runtimeSha
 ||request.target.sentryRelease!==runtimeSha||request.target.artifactDigest!==artifactDigest
 ||request.target.installedRuntimeDigest!==installedDigest
 ||request.target.recoveryRuntimeDigest!==recoveryDigest||request.target.version!==targetVersion
 ||request.releaseEvidence.releaseManifestSha256!==manifestSha
 ||request.releaseEvidence.stagingAttestationSha256!==stagingSha
 ||typeof request.predecessor.runtime!=='string'
 ||!(request.predecessor.runtime===productionBase
   ||request.predecessor.runtime.startsWith(`${productionBase}/releases/`))
 ||!/^[a-f0-9]{40}$/u.test(request.predecessor.sha||'')
 ||!/^[a-f0-9]{64}$/u.test(request.predecessor.artifactDigest||'')
 ||!/^[a-f0-9]{64}$/u.test(request.predecessor.installedRuntimeDigest||''))process.exit(1);
const created=Date.parse(request.createdAt||''),expires=Date.parse(request.expiresAt||''),now=Date.now();
if(!Number.isFinite(created)||!Number.isFinite(expires)||expires<=created
 ||expires-created>30*60*1000||created>now+5*60*1000)process.exit(1);
process.stdout.write(`${now>expires?'expired':'current'}\t${request.expiresAt}\n`);
NODE
      )" || {
        echo "unsigned promotion resume request identity is invalid" >&2
        exit 1
      }
      IFS=$'\t' read -r unsigned_request_state unsigned_request_expires_at \
        <<<"$UNSIGNED_REQUEST_FIELDS" || {
        echo "unsigned promotion resume request fields are invalid" >&2
        exit 1
      }
      case "$unsigned_request_state" in
        current) ;;
        expired)
          set +e
          unsigned_status_json="$("${SSH[@]}" "$SERVER" sudo -n "$SYSTEMD_CONTROL" \
            status "$PROMOTION_RUN_ID" 2>/dev/null)"
          unsigned_status_exit=$?
          set -e
          if [ "$unsigned_status_exit" -ne 66 ]; then
            if [ "$unsigned_status_exit" -eq 0 ]; then
              echo "server promotion authority exists but its local signed envelope is unavailable: $PROMOTION_RUN_ID" >&2
            else
              echo "unable to prove expired unsigned promotion authority is absent: $PROMOTION_RUN_ID" >&2
            fi
            exit 75
          fi
          printf '%s' "$unsigned_status_json" | node -e '
            let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
              const x=JSON.parse(b),keys=Object.keys(x).sort().join(",");
              if(keys!=="schema,status,transactionId"
                ||x.schema!=="nexus.promotion-transaction-status.v1"
                ||x.transactionId!==process.argv[1]||x.status!=="not_found")process.exit(1);
            });' "$PROMOTION_RUN_ID" || {
            echo "authoritative expired-unsigned not-found response is invalid" >&2
            exit 1
          }
          unsigned_archive_dir="$TRANSACTION_CHECKPOINT_DIR/expired-unsigned-authority"
          if [ -e "$unsigned_archive_dir" ] || [ -L "$unsigned_archive_dir" ]; then
            [ -d "$unsigned_archive_dir" ] && [ ! -L "$unsigned_archive_dir" ] || {
              echo "expired unsigned promotion archive directory is unsafe" >&2
              exit 1
            }
          else
            mkdir "$unsigned_archive_dir"
          fi
          chmod 700 "$unsigned_archive_dir"
          unsigned_archive="$unsigned_archive_dir/${PROMOTION_RUN_ID}.json"
          node - "$unsigned_archive" "$TRANSACTION_CHECKPOINT" "$unsigned_resume_request" \
            "$unsigned_status_json" "$PROMOTION_RUN_ID" "$unsigned_request_expires_at" <<'NODE'
const crypto=require('crypto'),fs=require('fs'),path=require('path');
const [output,checkpointPath,requestPath,statusRaw,id,expiresAt]=process.argv.slice(2);
const read=(file)=>{
 const stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size===0
   ||stat.size>16*1024*1024||![0o400,0o600].includes(stat.mode&0o777))process.exit(1);
 return fs.readFileSync(file);
};
const checkpoint=read(checkpointPath),request=read(requestPath),status=JSON.parse(statusRaw);
if(Object.keys(status).sort().join(',')!=='schema,status,transactionId'
 ||status.schema!=='nexus.promotion-transaction-status.v1'
 ||status.transactionId!==id||status.status!=='not_found'
 ||!Number.isFinite(Date.parse(expiresAt)))process.exit(1);
const digest=(body)=>crypto.createHash('sha256').update(body).digest('hex');
const body=Buffer.from(`${JSON.stringify({
 schema:'nexus.expired-unsigned-promotion-authority.v1',
 transactionId:id,reason:'expired_unsigned_request_server_not_found',
 requestExpiredAt:expiresAt,authorityStatus:status,
 clientCheckpoint:{sha256:digest(checkpoint),bodyBase64:checkpoint.toString('base64')},
 unsignedRequest:{sha256:digest(request),bodyBase64:request.toString('base64')},
},null,2)}\n`);
const parent=path.dirname(output),prefix=`.${path.basename(output)}.next.`;
const parentStat=fs.lstatSync(parent);
if(!parentStat.isDirectory()||parentStat.isSymbolicLink()
  ||(parentStat.mode&0o777)!==0o700
  ||path.dirname(path.resolve(output))!==path.resolve(parent))process.exit(1);
const lstat=(file)=>{
 try{return fs.lstatSync(file);}
 catch(error){if(error?.code==='ENOENT')return null;throw error;}
};
const fsyncParent=()=>{
 const descriptor=fs.openSync(parent,'r');
 try{fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
};
const validateExisting=()=>{
 let stat=lstat(output);
 if(!stat||!stat.isFile()||stat.isSymbolicLink()
   ||(stat.mode&0o777)!==0o600||!fs.readFileSync(output).equals(body))process.exit(1);
 if(stat.nlink>1){
  let removed=false;
  for(const name of fs.readdirSync(parent)){
   if(!name.startsWith(prefix))continue;
   const candidate=path.join(parent,name),candidateStat=lstat(candidate);
   if(!candidateStat||!candidateStat.isFile()||candidateStat.isSymbolicLink()
     ||candidateStat.dev!==stat.dev||candidateStat.ino!==stat.ino
     ||!fs.readFileSync(candidate).equals(body))continue;
   fs.unlinkSync(candidate);
   removed=true;
  }
  if(removed)fsyncParent();
  stat=fs.lstatSync(output);
 }
 if(stat.nlink!==1)process.exit(1);
};
if(lstat(output))validateExisting();
else{
 const temporary=path.join(parent,
   `${prefix}${process.pid}.${crypto.randomBytes(12).toString('hex')}`);
 let descriptor;
 try{
  descriptor=fs.openSync(temporary,'wx',0o600);
  try{fs.writeFileSync(descriptor,body);fs.fsyncSync(descriptor);}
  finally{fs.closeSync(descriptor);descriptor=undefined;}
  try{fs.linkSync(temporary,output);fsyncParent();}
  catch(error){if(error?.code!=='EEXIST')throw error;validateExisting();}
  fs.unlinkSync(temporary);
  fsyncParent();
 validateExisting();
 }finally{if(descriptor!==undefined)fs.closeSync(descriptor);}
}
NODE
          fsync_local_directory "$unsigned_archive_dir"
          fsync_local_directory "$TRANSACTION_CHECKPOINT_DIR"
          RETIRED_UNSIGNED_TRANSACTION_ID="$PROMOTION_RUN_ID"
          TRANSACTION_CHECKPOINT_EXISTS=false
          PROMOTION_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
          ;;
        *)
          echo "unsigned promotion resume request expiry state is invalid" >&2
          exit 1
          ;;
      esac
    fi
  fi
fi

if [ "$RESUME_EXISTING_TRANSACTION" = true ]; then
  # Status was already reconciled above. Only discover the PM2 binary needed
  # for the final completed identity proof; do not rerun preparation or launch.
  REMOTE_PM2=/usr/local/bin/pm2
  "${SSH[@]}" "$SERVER" test -x "$REMOTE_PM2"
else
"$ROOT/scripts/env-parity-check.sh" --server "$SERVER" --staging-dir "$STAGING_BASE" --prod-dir "$PROD_BASE"
REMOTE_PM2=/usr/local/bin/pm2
"${SSH[@]}" "$SERVER" test -x "$REMOTE_PM2"
CAPACITY_ARGS=(--role production --base-dir "$PROD_BASE" --pm2-bin "$REMOTE_PM2")
"${SSH[@]}" "$SERVER" bash -s -- "${CAPACITY_ARGS[@]}" < "$ROOT/scripts/remote-release-capacity.sh"
CURRENT_RUNTIME="$("${SSH[@]}" "$SERVER" bash -s -- "$PROD_BASE" <<'REMOTE_CURRENT'
set -euo pipefail
base_dir="$1"
if [ -L "$base_dir/current" ]; then readlink -f "$base_dir/current"; else printf '%s' "$base_dir"; fi
REMOTE_CURRENT
)"
case "$CURRENT_RUNTIME" in
  "$PROD_BASE"|"$PROD_BASE"/releases/*) ;;
  *) echo "unsafe current production runtime: $CURRENT_RUNTIME" >&2; exit 1 ;;
esac
if [ "$RETRY_TERMINAL_PREDECESSOR" = true ] \
    && [ "$CURRENT_RUNTIME" != "$RETRY_PREDECESSOR_RUNTIME" ]; then
  echo "terminal predecessor identity changed before fresh authorization" >&2
  exit 75
fi

# `current` and the two PM2 cwd values are one control-plane identity. Refuse
# to copy or stop anything when they disagree; otherwise a stale symlink could
# make the backup and recovery target a different runtime than the live one.
verify_active_runtime() {
  "${SSH[@]}" "$SERVER" bash -s -- "$CURRENT_RUNTIME" "$PROD_BASE" "$REMOTE_PM2" <<'REMOTE_ACTIVE_IDENTITY'
set -euo pipefail
runtime="$1"; base_dir="$2"; pm2_bin="$3"
[ -x "$pm2_bin" ] || { echo "PM2 is unavailable" >&2; exit 1; }
if [ "$runtime" != "$base_dir" ]; then
  [ "$(readlink -f "$base_dir/current")" = "$runtime" ] || { echo "production current symlink drift" >&2; exit 1; }
  [ -f "$runtime/.complete.json" ] || { echo "active versioned runtime marker is missing" >&2; exit 1; }
  active_sha="$(node -e 'const x=require(process.argv[1]);process.stdout.write(x.runtimeSha||"")' "$runtime/.complete.json")"
  [[ "$active_sha" =~ ^[0-9a-f]{40}$ ]] || { echo "active versioned runtime SHA is invalid" >&2; exit 1; }
else
  [ ! -e "$base_dir/current" ] || { echo "legacy runtime cannot have a current link" >&2; exit 1; }
  active_sha=""
fi
timeout 5s "$pm2_bin" jlist | node -e '
const fs = require("fs");
const rows = JSON.parse(fs.readFileSync(0, "utf8"));
const runtime = process.argv[1];
const runtimeSha = process.argv[2];
const expected = new Map([
  ["nexus-hub", runtime],
  ["content-engine", `${runtime}/content-engine`],
]);
for (const [name, cwd] of expected) {
  const row = rows.find((entry) => entry?.name === name);
  const observedSha = row?.pm2_env?.NEXUS_RELEASE_SHA || row?.pm2_env?.GIT_COMMIT || null;
  if (row?.pm2_env?.status !== "online" || row?.pm2_env?.pm_cwd !== cwd || (runtimeSha && observedSha !== runtimeSha)) {
    throw new Error(`active PM2/current identity mismatch: ${name}`);
  }
}' "$runtime" "$active_sha"
REMOTE_ACTIVE_IDENTITY
}
verify_active_runtime

read -r PREDECESSOR_SHA PREDECESSOR_ARTIFACT_DIGEST PREDECESSOR_INSTALLED_RUNTIME_DIGEST \
  < <("${SSH[@]}" "$SERVER" bash -s -- "$CURRENT_RUNTIME" "$PROD_BASE" "$REMOTE_PM2" <<'REMOTE_PREDECESSOR_SHA'
set -euo pipefail
runtime="$1"; base_dir="$2"; pm2_bin="$3"
if [ "$runtime" != "$base_dir" ]; then
  node - "$runtime/.complete.json" "$runtime/.nexus-installed-runtime.json" <<'NODE'
const fs=require('fs');const marker=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const installed=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
process.stdout.write(`${marker.runtimeSha||''} ${marker.artifactDigest||''} ${installed.aggregateDigest||''}\n`);
NODE
  exit 0
fi
echo "legacy production runtime has no exact artifact/install identity" >&2
exit 1
REMOTE_PREDECESSOR_SHA
)
[[ "$PREDECESSOR_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  echo "active predecessor runtime SHA is unavailable" >&2
  exit 1
}
if [ "$RETRY_TERMINAL_PREDECESSOR" = true ] \
    && [ "$PREDECESSOR_SHA" != "$RETRY_PREDECESSOR_SHA" ]; then
  echo "terminal predecessor SHA changed before fresh authorization" >&2
  exit 75
fi
[[ "$PREDECESSOR_ARTIFACT_DIGEST" =~ ^[0-9a-f]{64}$ \
    && "$PREDECESSOR_INSTALLED_RUNTIME_DIGEST" =~ ^[0-9a-f]{64}$ ]] || {
  echo "active predecessor exact artifact/install identity is unavailable" >&2
  exit 1
}
if [ "$RETRY_TERMINAL_PREDECESSOR" = true ] \
    && { [ "$PREDECESSOR_ARTIFACT_DIGEST" != "$RETRY_PREDECESSOR_ARTIFACT_DIGEST" ] \
      || [ "$PREDECESSOR_INSTALLED_RUNTIME_DIGEST" \
        != "$RETRY_PREDECESSOR_INSTALLED_RUNTIME_DIGEST" ]; }; then
  echo "terminal predecessor artifact/install identity changed before fresh authorization" >&2
  exit 75
fi
git -C "$ROOT" rev-parse --verify --quiet "${PREDECESSOR_SHA}^{commit}" >/dev/null || {
  echo "active predecessor runtime SHA is absent from the release checkout" >&2
  exit 1
}
git -C "$ROOT" merge-base --is-ancestor "$PREDECESSOR_SHA" "$RUNTIME_SHA" || {
  echo "active predecessor is not an ancestor of the target runtime" >&2
  exit 1
}

CONTENT_WORKSPACE_ROLLOUT_REQUIRED=false
CONTENT_WORKSPACE_MIGRATIONS=()
for migration_id in $(seq 239 253); do
  while IFS= read -r migration_path; do
    [ -n "$migration_path" ] && CONTENT_WORKSPACE_MIGRATIONS+=("$migration_path")
  done < <(git -C "$ROOT" ls-files "migrations/${migration_id}_*.sql")
done
[ "${#CONTENT_WORKSPACE_MIGRATIONS[@]}" -eq 15 ] || {
  echo "canonical Content workspace migration inventory is incomplete" >&2
  exit 1
}
set +e
git -C "$ROOT" diff --quiet "$PREDECESSOR_SHA" "$RUNTIME_SHA" -- "${CONTENT_WORKSPACE_MIGRATIONS[@]}"
CONTENT_WORKSPACE_DIFF_STATUS=$?
set -e
case "$CONTENT_WORKSPACE_DIFF_STATUS" in
  0) ;;
  1) CONTENT_WORKSPACE_ROLLOUT_REQUIRED=true ;;
  *) echo "unable to determine Content workspace rollout requirement" >&2; exit 1 ;;
esac

MIGRATION_REVIEW_EVIDENCE="${NEXUS_MIGRATION_REVIEW_EVIDENCE:-$ROOT/.local/release/migration-review/current.json}"
MIGRATION_REVIEW_JSON="$(node "$ROOT/scripts/migration-safety-check.mjs" \
  --base "$PREDECESSOR_SHA" \
  --changed-only \
  --approval-mode review \
  --review-evidence "$MIGRATION_REVIEW_EVIDENCE" \
  --json)"
MIGRATION_REVIEW_COUNT="$(printf '%s' "$MIGRATION_REVIEW_JSON" | node -e '
let body="";process.stdin.on("data",c=>body+=c);process.stdin.on("end",()=>{
  const value=JSON.parse(body).irreversibleChangedMigrations;
  if(!Array.isArray(value))process.exit(1);process.stdout.write(String(value.length));
});')"
MIGRATION_REVIEW_SHA256="$(printf '%s' "$MIGRATION_REVIEW_JSON" | node -e '
let body="";process.stdin.on("data",c=>body+=c);process.stdin.on("end",()=>{
  const value=JSON.parse(body).reviewEvidence?.sha256||"";
  process.stdout.write(value);
});')"
MIGRATION_POLICY_SUBJECT_SHA256="$(printf '%s' "$MIGRATION_REVIEW_JSON" | node -e '
let body="";process.stdin.on("data",c=>body+=c);process.stdin.on("end",()=>{
  const value=JSON.parse(body).reviewEvidence?.policySubjectSha256||"";
  process.stdout.write(value);
});')"
[[ "$MIGRATION_REVIEW_COUNT" =~ ^[0-9]+$ ]] || { echo "migration review count is invalid" >&2; exit 1; }
if [ "$MIGRATION_REVIEW_COUNT" -gt 0 ]; then
  [[ "$MIGRATION_REVIEW_SHA256" =~ ^[a-f0-9]{64}$ ]] || { echo "migration review evidence digest is invalid" >&2; exit 1; }
  [[ "$MIGRATION_POLICY_SUBJECT_SHA256" =~ ^[a-f0-9]{64}$ ]] || { echo "migration policy subject digest is invalid" >&2; exit 1; }
fi

# Without signed resume authority, an already-active exact target is
# ambiguous. Reject it before creating a checkpoint or touching release bytes.
if [ "$CURRENT_RUNTIME" = "$PROD_RELEASE" ]; then
  echo "exact release is already active without a reconcilable transaction; refusing to mutate the live runtime: $PROD_RELEASE" >&2
  exit 75
fi

if [ "$TRANSACTION_CHECKPOINT_EXISTS" = false ]; then
  while :; do
    PROMOTION_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$-$(node -e 'process.stdout.write(require("crypto").randomBytes(6).toString("hex"))')"
    [ -z "$RETIRED_UNSIGNED_TRANSACTION_ID" ] \
      || [ "$PROMOTION_RUN_ID" != "$RETIRED_UNSIGNED_TRANSACTION_ID" ] || continue
    break
  done
  checkpoint_temporary="$TRANSACTION_CHECKPOINT.$$.${PROMOTION_RUN_ID##*-}.tmp"
  node - "$checkpoint_temporary" "$PROMOTION_RUN_ID" "$PROMOTION_STARTED_AT" "$RUNTIME_SHA" \
    "$ARTIFACT_DIGEST" "$INSTALLED_RUNTIME_DIGEST" "$RECOVERY_RUNTIME_DIGEST" \
    "$RELEASE_MANIFEST_SHA256" "$STAGING_ATTESTATION_SHA256" \
    "$TARGET_VERSION" "$SERVER" "$PROD_BASE" "$RETIRED_UNSIGNED_TRANSACTION_ID" <<'NODE'
const fs = require('fs');
const [file, transactionId, startedAt, runtimeSha, artifactDigest, installedRuntimeDigest,
  recoveryRuntimeDigest, releaseManifestSha256, stagingAttestationSha256,
  targetVersion, server, productionBase,retiredUnsignedTransactionId] = process.argv.slice(2);
const checkpoint={
  schema:'nexus.promotion-client-checkpoint.v1',transactionId,startedAt,runtimeSha,
  artifactDigest,installedRuntimeDigest,recoveryRuntimeDigest,releaseManifestSha256,
  stagingAttestationSha256,targetVersion,server,productionBase,
};
if(retiredUnsignedTransactionId)checkpoint.retiredUnsignedTransactionId=retiredUnsignedTransactionId;
const fd=fs.openSync(file,'wx',0o600);
try{fs.writeFileSync(fd,`${JSON.stringify(checkpoint,null,2)}\n`);fs.fsyncSync(fd);}
finally{fs.closeSync(fd);}
NODE
  node - "$checkpoint_temporary" "$TRANSACTION_CHECKPOINT" "$TRANSACTION_CHECKPOINT_DIR" <<'NODE'
const fs=require('fs');const path=require('path');
const [temporary,destination,parent]=process.argv.slice(2);
const staged=fs.lstatSync(temporary);
if(path.dirname(temporary)!==parent||path.dirname(destination)!==parent
 ||!staged.isFile()||staged.isSymbolicLink()||staged.nlink!==1
 ||(staged.mode&0o777)!==0o600)process.exit(1);
let current=null;
try{current=fs.lstatSync(destination);}catch(error){if(error?.code!=='ENOENT')throw error;}
if(current!==null){
 if(!current.isFile()||current.isSymbolicLink()||current.nlink!==1
  ||![0o400,0o600].includes(current.mode&0o777))process.exit(1);
}
let descriptor=fs.openSync(temporary,'r');
try{fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
fs.renameSync(temporary,destination);
descriptor=fs.openSync(parent,'r');
try{fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
NODE
  # The hardened Node rename is the atomic equivalent of:
  # mv "$checkpoint_temporary" "$TRANSACTION_CHECKPOINT"
  # Its parent descriptor fsync is the durable equivalent of:
  # fsync_local_directory "$TRANSACTION_CHECKPOINT_DIR"
  if [ -n "$RETIRED_UNSIGNED_TRANSACTION_ID" ]; then
    cleanup_retired_unsigned_request "$RETIRED_UNSIGNED_TRANSACTION_ID"
  fi
fi

# Copy the already prepared staging runtime while production is still online.
# The root control owns the containing directory and creates (or recognizes)
# only the exact canonical target, so the application account cannot replace
# the target while it is copied and sealed.
[ "$SYSTEMD_TRANSACTION_AVAILABLE" = true ] || {
  echo "root-owned runtime preparation is unavailable; legacy target mutation is disabled" >&2
  exit 1
}
TARGET_PREPARATION="$("${SSH[@]}" "$SERVER" sudo -n "$SYSTEMD_CONTROL" prepare-runtime-target \
  "$PROD_RELEASE" "$PROD_BASE")"
TARGET_WRITABLE="$(printf '%s' "$TARGET_PREPARATION" | node -e '
let body="";process.stdin.on("data",(chunk)=>body+=chunk);process.stdin.on("end",()=>{
  const x=JSON.parse(body);if(x.ok!==true||typeof x.writable!=="boolean")process.exit(1);
  process.stdout.write(String(x.writable));
});')" || { echo "root-owned runtime preparation result is invalid" >&2; exit 1; }

# Verify every governed artifact byte before production is touched.
"${SSH[@]}" "$SERVER" bash -s -- \
  "$STAGING_RELEASE" "$PROD_RELEASE" "$PROD_BASE" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" \
  "$INSTALLED_RUNTIME_DIGEST" "$TARGET_WRITABLE" <<'REMOTE_PREPARE'
set -euo pipefail
staging_release="$1"; release_dir="$2"; base_dir="$3"; runtime_sha="$4"; expected_digest="$5"; installed_digest="$6"; target_writable="$7"
[ -f "$staging_release/.complete.json" ] || { echo "staged immutable release is missing" >&2; exit 1; }
case "$target_writable" in true|false) ;; *) echo "invalid root target preparation state" >&2; exit 1 ;; esac
for governed in "$base_dir" "$staging_release"; do
  [ -d "$governed" ] && [ ! -L "$governed" ] && [ "$(readlink -f "$governed")" = "$governed" ] || {
    echo "promotion directory is not a canonical non-symlink directory: $governed" >&2
    exit 1
  }
done
[ -d "$base_dir/releases" ] && [ ! -L "$base_dir/releases" ] \
  && [ "$(readlink -f "$base_dir/releases")" = "$base_dir/releases" ] \
  && [ ! -w "$base_dir/releases" ] || { echo "root-owned production releases parent is unsafe" >&2; exit 1; }
[ -d "$release_dir" ] && [ ! -L "$release_dir" ] && [ "$(readlink -f "$release_dir")" = "$release_dir" ] || {
  echo "root-prepared production release target is unsafe" >&2
  exit 1
}
if [ "$target_writable" = true ]; then
  rsync -a --delete --chmod=D700,Fu+rw,go-rwx "$staging_release/" "$release_dir/"
  for link in .env data logs; do
    if [ -L "$release_dir/$link" ]; then rm -f "$release_dir/$link";
    elif [ -e "$release_dir/$link" ]; then rm -rf "$release_dir/$link"; fi
  done
  ln -s "$base_dir/.env" "$release_dir/.env"
  ln -s "$base_dir/data" "$release_dir/data"
  ln -s "$base_dir/logs" "$release_dir/logs"
else
  for link in .env data logs; do
    [ -L "$release_dir/$link" ] || { echo "existing exact release link is missing: $link" >&2; exit 1; }
  done
  [ "$(readlink "$release_dir/.env")" = "$base_dir/.env" ] \
    && [ "$(readlink "$release_dir/data")" = "$base_dir/data" ] \
    && [ "$(readlink "$release_dir/logs")" = "$base_dir/logs" ] || {
    echo "existing exact release link identity mismatch" >&2
    exit 1
  }
fi
node - "$release_dir" "$runtime_sha" "$expected_digest" <<'NODE'
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const [releaseDir, runtimeSha, expectedDigest] = process.argv.slice(2);
const artifact = JSON.parse(fs.readFileSync(path.join(releaseDir, 'artifact-manifest.json'), 'utf8'));
const marker = JSON.parse(fs.readFileSync(path.join(releaseDir, '.complete.json'), 'utf8'));
if (marker.runtimeSha !== runtimeSha || marker.artifactDigest !== expectedDigest) {
  throw new Error('staged release identity mismatch');
}
for (const entry of artifact.files) {
  const body = fs.readFileSync(path.join(releaseDir, entry.path));
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  if (body.length !== entry.size || digest !== entry.sha256) {
    throw new Error(`artifact file mismatch: ${entry.path}`);
  }
}
const digestInput = JSON.stringify({
  schema: 'nexus.release-artifact-manifest.v1',
  files: artifact.files.map(({ path: filePath, size, sha256 }) => ({ path: filePath, size, sha256 })),
});
const digest = crypto.createHash('sha256').update(digestInput).digest('hex');
if (digest !== expectedDigest || artifact.digest !== expectedDigest) {
  throw new Error('artifact aggregate digest mismatch');
}
NODE
REMOTE_PREPARE

# The narrow root control verifies artifact bytes, dependency trees, runtime
# inventory and link targets with root-installed code, then removes application
# write permission before any candidate script is executed.
"${SSH[@]}" "$SERVER" sudo -n "$SYSTEMD_CONTROL" seal-runtime \
  "$PROD_RELEASE" "$PROD_BASE" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$INSTALLED_RUNTIME_DIGEST" >/dev/null

# Run the candidate's owner-bootstrap and canonical environment preflight
# against production data while the predecessor is still online. Failure here
# cannot create downtime and never reaches the cutover recovery path.
PRODUCTION_PREFLIGHT_ARGS=(
  --role production --base-dir "$PROD_BASE" --release-dir "$PROD_RELEASE" --node-bin /usr/bin/node
)
if [ "$CONTENT_WORKSPACE_ROLLOUT_REQUIRED" = true ]; then
  PRODUCTION_PREFLIGHT_ARGS+=(--require-content-workspace-owner-write)
fi
"${SSH[@]}" "$SERVER" bash "$PROD_RELEASE/scripts/remote-release-preflight.sh" \
  "${PRODUCTION_PREFLIGHT_ARGS[@]}"

# State-coupled migrations must prove that the exact candidate can migrate a
# consistent online backup of the live production-shaped database before the
# first stop. The remote runner emits aggregate identities and pass/fail facts
# only, after deleting its private clone and sidecars. Bind that fresh proof to
# this one promotion invocation so an older successful rehearsal cannot replay.
MIGRATION_REHEARSAL_EVIDENCE=""
MIGRATION_REHEARSAL_SHA256=""
MIGRATION_REHEARSAL_CLONE_SHA256=""
MIGRATION_REHEARSAL_MIGRATED_CLONE_SHA256=""
MIGRATION_REHEARSAL_PENDING_SET_SHA256=""
MIGRATION_REHEARSAL_SOURCE_DATABASE_SHA256=""
if [ "$MIGRATION_REVIEW_COUNT" -gt 0 ]; then
  set +e
  MIGRATION_REHEARSAL_OUTPUT="$("${SSH[@]}" "$SERVER" \
    bash "$PROD_RELEASE/scripts/remote-production-shape-migration-rehearsal.sh" \
      "$PROD_RELEASE" "$PROD_BASE" "$CURRENT_RUNTIME" "$REMOTE_PM2" \
      "$PREDECESSOR_SHA" "$RUNTIME_SHA" "$TARGET_VERSION" "$ARTIFACT_DIGEST" \
      "$MIGRATION_REVIEW_SHA256" "$MIGRATION_POLICY_SUBJECT_SHA256" "$PROMOTION_RUN_ID" \
      online_pre_stop online)"
  MIGRATION_REHEARSAL_EXIT=$?
  set -e
  if [ "$MIGRATION_REHEARSAL_EXIT" -ne 0 ]; then
    echo "production-shape migration rehearsal failed before production stop" >&2
    exit "$MIGRATION_REHEARSAL_EXIT"
  fi
  MIGRATION_REHEARSAL_EVIDENCE="$ROOT/.local/release/production/${RUNTIME_SHA}-${ARTIFACT_DIGEST}-${PROMOTION_RUN_ID}.migration-rehearsal.json"
  install -d -m 700 "$(dirname "$MIGRATION_REHEARSAL_EVIDENCE")"
  printf '%s' "$MIGRATION_REHEARSAL_OUTPUT" | node -e '
    const fs=require("fs");const output=process.argv[1];let raw="";
    process.stdin.on("data",(chunk)=>raw+=chunk);process.stdin.on("end",()=>{
      const parsed=JSON.parse(raw);const temporary=`${output}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(temporary,`${JSON.stringify(parsed,null,2)}\n`,{mode:0o600,flag:"wx"});
        fs.linkSync(temporary,output);fs.rmSync(temporary,{force:true});fs.chmodSync(output,0o600);
      } finally { fs.rmSync(temporary,{force:true}); }
    });' "$MIGRATION_REHEARSAL_EVIDENCE"
  MIGRATION_REHEARSAL_VALIDATION="$(node "$ROOT/scripts/validate-production-shape-migration-rehearsal.mjs" \
    --root "$ROOT" \
    --evidence "$MIGRATION_REHEARSAL_EVIDENCE" \
    --predecessor-runtime-sha "$PREDECESSOR_SHA" \
    --target-runtime-sha "$RUNTIME_SHA" \
    --target-version "$TARGET_VERSION" \
    --artifact-digest "$ARTIFACT_DIGEST" \
    --review-evidence-sha256 "$MIGRATION_REVIEW_SHA256" \
    --migration-policy-subject-sha256 "$MIGRATION_POLICY_SUBJECT_SHA256" \
    --promotion-run-id "$PROMOTION_RUN_ID" \
    --phase online_pre_stop \
    --database-owner-state online)"
  read -r MIGRATION_REHEARSAL_SHA256 MIGRATION_REHEARSAL_CLONE_SHA256 \
    MIGRATION_REHEARSAL_MIGRATED_CLONE_SHA256 MIGRATION_REHEARSAL_PENDING_SET_SHA256 \
    MIGRATION_REHEARSAL_SOURCE_DATABASE_SHA256 \
    < <(printf '%s' "$MIGRATION_REHEARSAL_VALIDATION" | node -e '
      let raw="";process.stdin.on("data",(chunk)=>raw+=chunk);process.stdin.on("end",()=>{
        const value=JSON.parse(raw);process.stdout.write([
          value.evidenceSha256,value.cloneSha256,value.migratedCloneSha256,
          value.pendingMigrationSetSha256,value.sourceDatabaseSha256,
        ].join(" ") + "\n");
      });')
  for digest in "$MIGRATION_REHEARSAL_SHA256" "$MIGRATION_REHEARSAL_CLONE_SHA256" \
      "$MIGRATION_REHEARSAL_MIGRATED_CLONE_SHA256" "$MIGRATION_REHEARSAL_PENDING_SET_SHA256" \
      "$MIGRATION_REHEARSAL_SOURCE_DATABASE_SHA256"; do
    [[ "$digest" =~ ^[a-f0-9]{64}$ ]] || { echo "migration rehearsal returned an invalid identity" >&2; exit 1; }
  done
fi

# Prepare the immutable runtime portion of the rollback archive while the
# current production services are still online. Only the quiescent SQLite
# snapshot is added during the cutover window.
PREPARE_BACKUP_OUTPUT="$("${SSH[@]}" "$SERVER" bash -s -- "$CURRENT_RUNTIME" "$BACKUP_DIR" \
  < "$ROOT/scripts/remote-prepare-release-backup.sh")"
printf '%s\n' "$PREPARE_BACKUP_OUTPUT"
PREPARED_RUNTIME_DIR="$(printf '%s\n' "$PREPARE_BACKUP_OUTPUT" | sed -n 's/^NEXUS_PREPARED_RUNTIME_DIR=//p' | tail -1)"
case "$PREPARED_RUNTIME_DIR" in
  "$BACKUP_DIR"/.runtime-stage-*) ;;
  *) echo "runtime backup preparation returned an unsafe path" >&2; exit 1 ;;
esac
fi

run_systemd_transaction() {
  local request_dir request_file signed_request_file remote_inbox remote_request status_json="" phase="" transaction_status=""
  local result_env escrow_json deadline request_signing request_sha request_mode validated_request_sha
  local local_request_directory escrow_retry_attempts=0 next_escrow_retry_at=0 escrow_retry_delay retry_status
  request_dir="$ROOT/.local/release/transactions"
  request_file="$request_dir/${PROMOTION_RUN_ID}.request.json"
  signed_request_file="$request_dir/${PROMOTION_RUN_ID}.request.envelope.json"
  if [ "$RESUME_EXISTING_TRANSACTION" = true ]; then
    request_sha="$RESUME_REQUEST_SHA"
    status_json="$RESUME_STATUS_JSON"
  else
    for local_request_directory in "$ROOT/.local" "$ROOT/.local/release" "$request_dir"; do
      [ -d "$local_request_directory" ] && [ ! -L "$local_request_directory" ] || {
        echo "local promotion request directory is unsafe: $local_request_directory" >&2
        return 1
      }
    done
    if [ "$RESUME_SIGNED_REQUEST_PENDING" = true ] \
        && ! node -e 'const t=Date.parse(process.argv[1]);if(!Number.isFinite(t)||Date.now()>t)process.exit(1)' \
          "$RESUME_REQUEST_EXPIRES_AT"; then
      # The root control proved that no server authority exists for this ID.
      # Expired local authority may therefore be replaced in place only after
      # exact target/predecessor/capacity derivation has run again above.
      [ -f "$request_file" ] && [ ! -L "$request_file" ] \
        && [ -f "$signed_request_file" ] && [ ! -L "$signed_request_file" ] || {
        echo "expired local promotion authority is unsafe to replace" >&2
        return 1
      }
      rm -f -- "$request_file" "$signed_request_file"
      RESUME_SIGNED_REQUEST_PENDING=false
      RESUME_REQUEST_SHA=""
      RESUME_REQUEST_EXPIRES_AT=""
    fi
    if [ ! -f "$request_file" ]; then
      node - "$request_file" "$PROMOTION_RUN_ID" "$PROD_BASE" "$CURRENT_RUNTIME" "$PREDECESSOR_SHA" \
      "$PREDECESSOR_ARTIFACT_DIGEST" "$PREDECESSOR_INSTALLED_RUNTIME_DIGEST" \
      "$PROD_RELEASE" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$INSTALLED_RUNTIME_DIGEST" \
      "$RECOVERY_RUNTIME_DIGEST" "$RELEASE_MANIFEST" "$STAGING_ATTESTATION" "$TARGET_VERSION" \
      "$BACKUP_DIR" "$PREPARED_RUNTIME_DIR" "$REMOTE_PM2" "$PUBLIC_BASE_URL" \
      "60" "${NEXUS_RELEASE_LOCAL_GATE_TIMEOUT_SECONDS:-60}" \
      "$MIGRATION_REVIEW_COUNT" "$MIGRATION_REVIEW_SHA256" "$MIGRATION_POLICY_SUBJECT_SHA256" \
      "$MIGRATION_REHEARSAL_SHA256" "$MIGRATION_REHEARSAL_CLONE_SHA256" \
      "$MIGRATION_REHEARSAL_MIGRATED_CLONE_SHA256" "$MIGRATION_REHEARSAL_PENDING_SET_SHA256" \
      "$MIGRATION_REHEARSAL_SOURCE_DATABASE_SHA256" <<'NODE'
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const [output, transactionId, productionBase, predecessorRuntime, predecessorSha,
  predecessorArtifactDigest, predecessorInstalledRuntimeDigest, targetRuntime,
  targetSha, artifactDigest, installedRuntimeDigest, recoveryRuntimeDigest,
  releaseManifestPath, stagingAttestationPath, version, backupDir, preparedRuntimeDir,
  pm2Bin, publicBaseUrl, stabilitySeconds, gateTimeoutSeconds, migrationCount,
  reviewEvidenceSha256, policySubjectSha256, onlineEvidenceSha256, onlineCloneSha256,
  onlineMigratedCloneSha256, onlinePendingSetSha256, onlineSourceDatabaseSha256] = process.argv.slice(2);
const releaseManifestBytes = fs.readFileSync(releaseManifestPath);
const stagingAttestationBytes = fs.readFileSync(stagingAttestationPath);
const request = {
  schema: 'nexus.promotion-transaction-request.v1',
  transactionId,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  ownerAuthorization: 'explicit',
  productionBase,
  predecessor: { runtime: predecessorRuntime, sha: predecessorSha,
    artifactDigest: predecessorArtifactDigest, installedRuntimeDigest: predecessorInstalledRuntimeDigest },
  target: { runtime: targetRuntime, sha: targetSha, sentryRelease: targetSha, artifactDigest,
    installedRuntimeDigest, recoveryRuntimeDigest, version },
  releaseEvidence: {
    releaseManifestBase64: releaseManifestBytes.toString('base64'),
    releaseManifestSha256: crypto.createHash('sha256').update(releaseManifestBytes).digest('hex'),
    stagingAttestationBase64: stagingAttestationBytes.toString('base64'),
    stagingAttestationSha256: crypto.createHash('sha256').update(stagingAttestationBytes).digest('hex'),
  },
  backupDir,
  preparedRuntimeDir,
  pm2Bin,
  publicBaseUrl,
  stabilitySeconds: Number(stabilitySeconds),
  gateTimeoutSeconds: Number(gateTimeoutSeconds),
  migration: {
    required: Number(migrationCount) > 0,
    reviewEvidenceSha256: reviewEvidenceSha256 || null,
    policySubjectSha256: policySubjectSha256 || null,
    onlineEvidenceSha256: onlineEvidenceSha256 || null,
    onlineCloneSha256: onlineCloneSha256 || null,
    onlineMigratedCloneSha256: onlineMigratedCloneSha256 || null,
    onlinePendingSetSha256: onlinePendingSetSha256 || null,
    onlineSourceDatabaseSha256: onlineSourceDatabaseSha256 || null,
  },
};
const body=Buffer.from(`${JSON.stringify(request,null,2)}\n`);
const parent=path.dirname(output);
const parentStat=fs.lstatSync(parent);
if(!parentStat.isDirectory()||parentStat.isSymbolicLink()
  ||path.dirname(path.resolve(output))!==path.resolve(parent))process.exit(1);
const temporary=path.join(
  parent,`.${path.basename(output)}.next.${process.pid}.${crypto.randomBytes(12).toString('hex')}`,
);
const fsyncParent=()=>{
 const descriptor=fs.openSync(parent,'r');
 try{fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
};
let descriptor;
try{
 descriptor=fs.openSync(temporary,'wx',0o600);
 fs.writeFileSync(descriptor,body);
 fs.fsyncSync(descriptor);
 fs.closeSync(descriptor);
 descriptor=undefined;
 fs.linkSync(temporary,output);
 fsyncParent();
 fs.unlinkSync(temporary);
 fsyncParent();
 const stat=fs.lstatSync(output);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1
   ||(stat.mode&0o777)!==0o600||!fs.readFileSync(output).equals(body))process.exit(1);
}finally{
 if(descriptor!==undefined)fs.closeSync(descriptor);
}
NODE
      fsync_local_directory "$request_dir"
    fi
    [ -f "$request_file" ] && [ ! -L "$request_file" ] || {
      echo "local promotion request must be a regular non-symlink file" >&2
      return 1
    }
    request_mode="$(stat -c '%a' "$request_file" 2>/dev/null || stat -f '%Lp' "$request_file")"
    case "$request_mode" in
      400|600) ;;
      *)
        echo "local promotion request mode must be 400 or 600" >&2
        return 1
        ;;
    esac
    if [ "$RESUME_SIGNED_REQUEST_PENDING" = true ]; then
      [ -f "$signed_request_file" ] && [ ! -L "$signed_request_file" ] || {
        echo "reconciled local promotion authority is missing or unsafe" >&2
        return 1
      }
    else
      [ ! -e "$signed_request_file" ] && [ ! -L "$signed_request_file" ] || {
        echo "unexpected signed promotion request exists without reconciled server authority" >&2
        return 1
      }
    fi

    # `.local/` is intentionally ignored, so a clean Git checkout does not
    # prove that a checkpoint-adjacent raw request is trustworthy. Bind every
    # request field to the release state derived above before allowing the
    # owner's private key to sign it. The returned digest is compared with the
    # signer result to close the validation/signing read boundary.
    validated_request_sha="$(node - "$request_file" "$PROMOTION_RUN_ID" "$PROD_BASE" "$CURRENT_RUNTIME" \
      "$PREDECESSOR_SHA" "$PREDECESSOR_ARTIFACT_DIGEST" "$PREDECESSOR_INSTALLED_RUNTIME_DIGEST" \
      "$PROD_RELEASE" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$INSTALLED_RUNTIME_DIGEST" \
      "$RECOVERY_RUNTIME_DIGEST" "$RELEASE_MANIFEST" "$STAGING_ATTESTATION" \
      "$RELEASE_MANIFEST_SHA256" "$STAGING_ATTESTATION_SHA256" "$TARGET_VERSION" \
      "$BACKUP_DIR" "$PREPARED_RUNTIME_DIR" "$REMOTE_PM2" "$PUBLIC_BASE_URL" \
      "60" "${NEXUS_RELEASE_LOCAL_GATE_TIMEOUT_SECONDS:-60}" \
      "$MIGRATION_REVIEW_COUNT" "$MIGRATION_REVIEW_SHA256" "$MIGRATION_POLICY_SUBJECT_SHA256" \
      "$MIGRATION_REHEARSAL_SHA256" "$MIGRATION_REHEARSAL_CLONE_SHA256" \
      "$MIGRATION_REHEARSAL_MIGRATED_CLONE_SHA256" "$MIGRATION_REHEARSAL_PENDING_SET_SHA256" \
      "$MIGRATION_REHEARSAL_SOURCE_DATABASE_SHA256" <<'LOCAL_REQUEST_VALIDATION'
const crypto = require('crypto');
const fs = require('fs');
const [file, transactionId, productionBase, predecessorRuntime, predecessorSha,
  predecessorArtifactDigest, predecessorInstalledRuntimeDigest, targetRuntime,
  targetSha, artifactDigest, installedRuntimeDigest, recoveryRuntimeDigest,
  releaseManifestPath, stagingAttestationPath, releaseManifestSha256,
  stagingAttestationSha256, targetVersion, backupDir,
  preparedRuntimeDir, pm2Bin, publicBaseUrl, stabilitySeconds, gateTimeoutSeconds,
  migrationCount, reviewEvidenceSha256, policySubjectSha256, onlineEvidenceSha256,
  onlineCloneSha256, onlineMigratedCloneSha256, onlinePendingSetSha256,
  onlineSourceDatabaseSha256] = process.argv.slice(2);
const request = JSON.parse(fs.readFileSync(file, 'utf8'));
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => isRecord(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
if (!exactKeys(request, [
  'schema', 'transactionId', 'createdAt', 'expiresAt', 'ownerAuthorization',
  'productionBase', 'predecessor', 'target', 'backupDir', 'preparedRuntimeDir',
  'pm2Bin', 'publicBaseUrl', 'stabilitySeconds', 'gateTimeoutSeconds', 'migration',
  'releaseEvidence',
]) || !exactKeys(request.predecessor, [
  'runtime', 'sha', 'artifactDigest', 'installedRuntimeDigest',
]) || !exactKeys(request.target, [
  'runtime', 'sha', 'sentryRelease', 'artifactDigest', 'installedRuntimeDigest', 'version',
  'recoveryRuntimeDigest',
]) || !exactKeys(request.releaseEvidence, [
  'releaseManifestBase64', 'releaseManifestSha256',
  'stagingAttestationBase64', 'stagingAttestationSha256',
]) || !exactKeys(request.migration, [
  'required', 'reviewEvidenceSha256', 'policySubjectSha256', 'onlineEvidenceSha256',
  'onlineCloneSha256', 'onlineMigratedCloneSha256', 'onlinePendingSetSha256',
  'onlineSourceDatabaseSha256',
])) process.exit(1);
const migrationRequired = Number(migrationCount) > 0;
const expectedMigration = {
  required: migrationRequired,
  reviewEvidenceSha256: reviewEvidenceSha256 || null,
  policySubjectSha256: policySubjectSha256 || null,
  onlineEvidenceSha256: onlineEvidenceSha256 || null,
  onlineCloneSha256: onlineCloneSha256 || null,
  onlineMigratedCloneSha256: onlineMigratedCloneSha256 || null,
  onlinePendingSetSha256: onlinePendingSetSha256 || null,
  onlineSourceDatabaseSha256: onlineSourceDatabaseSha256 || null,
};
if (request.schema !== 'nexus.promotion-transaction-request.v1'
    || request.transactionId !== transactionId
    || request.ownerAuthorization !== 'explicit'
    || request.productionBase !== productionBase
    || request.predecessor.runtime !== predecessorRuntime
    || request.predecessor.sha !== predecessorSha
    || request.predecessor.artifactDigest !== predecessorArtifactDigest
    || request.predecessor.installedRuntimeDigest !== predecessorInstalledRuntimeDigest
    || request.target.runtime !== targetRuntime
    || request.target.sha !== targetSha
    || request.target.sentryRelease !== targetSha
    || request.target.artifactDigest !== artifactDigest
    || request.target.installedRuntimeDigest !== installedRuntimeDigest
    || request.target.recoveryRuntimeDigest !== recoveryRuntimeDigest
    || request.target.version !== targetVersion
    || request.releaseEvidence.releaseManifestSha256 !== releaseManifestSha256
    || request.releaseEvidence.stagingAttestationSha256 !== stagingAttestationSha256
    || request.releaseEvidence.releaseManifestBase64 !== fs.readFileSync(releaseManifestPath).toString('base64')
    || request.releaseEvidence.stagingAttestationBase64 !== fs.readFileSync(stagingAttestationPath).toString('base64')
    || request.backupDir !== backupDir
    || request.preparedRuntimeDir !== preparedRuntimeDir
    || request.pm2Bin !== pm2Bin
    || request.publicBaseUrl !== publicBaseUrl
    || request.stabilitySeconds !== Number(stabilitySeconds)
    || request.gateTimeoutSeconds !== Number(gateTimeoutSeconds)
    || Object.entries(expectedMigration)
      .some(([key, value]) => request.migration[key] !== value)) process.exit(1);
const createdAt = Date.parse(request.createdAt || '');
const expiresAt = Date.parse(request.expiresAt || '');
const now = Date.now();
if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)
    || expiresAt <= createdAt || expiresAt - createdAt > 30 * 60 * 1000
    || createdAt > now + 5 * 60 * 1000 || now > expiresAt) process.exit(1);
const canonicalJson = (input) => {
  if (input === null || typeof input !== 'object') return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key])}`).join(',')}}`;
};
process.stdout.write(crypto.createHash('sha256').update(canonicalJson(request)).digest('hex'));
LOCAL_REQUEST_VALIDATION
    )" || {
      echo "local promotion request does not match the current derived release authority" >&2
      return 1
    }
    [[ "$validated_request_sha" =~ ^[a-f0-9]{64}$ ]] || {
      echo "validated local promotion request digest is invalid" >&2
      return 1
    }
    if [ "$RESUME_SIGNED_REQUEST_PENDING" = true ]; then
      request_sha="$RESUME_REQUEST_SHA"
    else
      request_signing="$(node "$ROOT/scripts/promotion-authorization.mjs" sign-request \
        --input "$request_file" --private-key "$OWNER_PRIVATE_KEY" --output "$signed_request_file")"
      fsync_local_directory "$request_dir"
      request_sha="$(printf '%s' "$request_signing" | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(b).payloadSha256))')"
    fi
    if [ "$request_sha" != "$validated_request_sha" ]; then
      if [ "$RESUME_SIGNED_REQUEST_PENDING" != true ]; then rm -f "$signed_request_file"; fi
      echo "owner-signed request differs from the validated local promotion request" >&2
      return 1
    fi
    [[ "$request_sha" =~ ^[a-f0-9]{64}$ ]] || { echo "owner-signed request digest is invalid" >&2; return 1; }

    # Recheck capacity immediately before handing the durable service its
    # authority; a Sonar analysis or pressure spike after the earlier preflight
    # must not overlap the production critical section.
    "${SSH[@]}" "$SERVER" bash -s -- "${CAPACITY_ARGS[@]}" < "$ROOT/scripts/remote-release-capacity.sh"
    remote_inbox="$PROD_BASE/.local/release/transaction-inbox"
    remote_request="$remote_inbox/$PROMOTION_RUN_ID.request.envelope.json"
    "${SSH[@]}" "$SERVER" install -d -m 700 "$remote_inbox"
    scp -q -o BatchMode=yes -o ConnectTimeout=10 "$signed_request_file" "$SERVER:$remote_request.next"
    "${SSH[@]}" "$SERVER" bash -s -- "$remote_request" <<'REMOTE_TRANSACTION_REQUEST'
set -euo pipefail
request="$1"
[ -f "$request.next" ] && [ ! -L "$request.next" ] || { echo "uploaded transaction request is unsafe" >&2; exit 1; }
chmod 600 "$request.next"
mv -f "$request.next" "$request"
REMOTE_TRANSACTION_REQUEST
    # launch is atomic and idempotent. A lost SSH response is reconciled by the
    # same signed transaction identity rather than creating another cutover.
    set +e
    launch_output="$("${SSH[@]}" "$SERVER" sudo -n "$SYSTEMD_CONTROL" launch "$remote_request" 2>&1)"
    launch_status=$?
    set -e
    if [ "$launch_status" -ne 0 ]; then
      # The server may have accepted the request before the transport failed.
      # Status is authoritative; only fail when it cannot prove this ID exists.
      if ! "${SSH[@]}" "$SERVER" sudo -n "$SYSTEMD_CONTROL" status "$PROMOTION_RUN_ID" >/dev/null 2>&1; then
        printf '%s\n' "$launch_output" >&2
        return "$launch_status"
      fi
      "${SSH[@]}" "$SERVER" sudo -n "$SYSTEMD_CONTROL" ensure-started \
        "$PROMOTION_RUN_ID" "$request_sha" >/dev/null
    fi
  fi

  result_env="$request_dir/${PROMOTION_RUN_ID}.result.env"
  escrow_json="$request_dir/${PROMOTION_RUN_ID}.escrow.json"
  # The root transaction has a 28-minute upper bound that contains two
  # separately bounded DR phases, candidate checks, cutover, and the soak.
  # Keep the polling client outside that ceiling so it can observe and fetch
  # the durable terminal result instead of timing out first.
  deadline=$((SECONDS + 2100))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ -z "$status_json" ]; then
      if ! status_json="$("${SSH[@]}" "$SERVER" sudo -n "$SYSTEMD_CONTROL" status "$PROMOTION_RUN_ID" 2>/dev/null)"; then
        # Tolerate bounded transient transport loss and reattach to the same
        # server-owned transaction on the next poll.
        sleep 2
        continue
      fi
    fi
    read -r phase transaction_status < <(printf '%s' "$status_json" | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const x=JSON.parse(b),id=process.argv[1],digest=process.argv[2];
        const statuses=new Set(["pending","running","recovery_required","escrow_pending",
          "completed","recovered","failed_before_stop","recovery_failed"]);
        if(x.schema!=="nexus.promotion-transaction-journal.v1"||x.transactionId!==id
          ||x.requestSha256!==digest||typeof x.phase!=="string"||!statuses.has(x.status))process.exit(1);
        process.stdout.write(`${x.phase} ${x.status}\n`);
      });' "$PROMOTION_RUN_ID" "$request_sha") || {
      echo "authoritative promotion transaction status is invalid" >&2
      return 1
    }
    case "$transaction_status" in
      completed) break ;;
      recovered|failed_before_stop|recovery_failed)
        printf '%s\n' "$status_json" >&2
        echo "persistent promotion transaction did not complete" >&2
        return 1
        ;;
      escrow_pending)
        # The service has its own short retry policy. If a sustained object-store
        # outage exhausts systemd's start-rate limit, resume the same immutable,
        # owner-authorized transaction through the root control. This retries
        # escrow only; it cannot repeat the cutover or create a second lane.
        if [ "$escrow_retry_attempts" -lt 8 ] && [ "$SECONDS" -ge "$next_escrow_retry_at" ]; then
          set +e
          "${SSH[@]}" "$SERVER" sudo -n "$SYSTEMD_CONTROL" retry-escrow "$PROMOTION_RUN_ID" >/dev/null 2>&1
          retry_status=$?
          set -e
          escrow_retry_attempts=$((escrow_retry_attempts + 1))
          escrow_retry_delay=$((10 * (1 << (escrow_retry_attempts > 5 ? 5 : escrow_retry_attempts - 1))))
          next_escrow_retry_at=$((SECONDS + escrow_retry_delay))
          # A lost SSH response is reconciled by the next authoritative status
          # read. Persistent denial remains bounded by the retry count/deadline.
          [ "$retry_status" -eq 0 ] || true
        fi
        ;;
      pending|running|recovery_required)
        # Close the accepted-authority/systemd-start crash window. The root
        # control reuses only the already persisted exact request digest.
        "${SSH[@]}" "$SERVER" sudo -n "$SYSTEMD_CONTROL" ensure-started \
          "$PROMOTION_RUN_ID" "$request_sha" >/dev/null 2>&1 || true
        ;;
    esac
    status_json=""
    sleep 2
  done
  [ "$transaction_status" = completed ] || { echo "timed out polling persistent promotion transaction" >&2; return 75; }
  result_raw="$("${SSH[@]}" "$SERVER" sudo -n "$SYSTEMD_CONTROL" fetch "$PROMOTION_RUN_ID" result)"
  escrow_raw="$("${SSH[@]}" "$SERVER" sudo -n "$SYSTEMD_CONTROL" fetch "$PROMOTION_RUN_ID" escrow)"
  fetch_suffix="$(node -e 'process.stdout.write(require("crypto").randomBytes(8).toString("hex"))')"
  result_temporary="$result_env.$fetch_suffix.tmp"
  escrow_temporary="$escrow_json.$fetch_suffix.tmp"
  node - "$result_temporary" "$result_raw" "$escrow_temporary" "$escrow_raw" <<'NODE'
const fs=require('fs');
const [resultPath,resultRaw,escrowPath,escrowRaw]=process.argv.slice(2);
for(const [file,raw,limit] of [[resultPath,resultRaw,1024*1024],[escrowPath,escrowRaw,16*1024*1024]]){
 const body=Buffer.from(`${raw}\n`);
 if(body.length===1||body.length>limit)process.exit(1);
 const fd=fs.openSync(file,'wx',0o600);
 try{fs.writeFileSync(fd,body);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
NODE
  mv -f "$result_temporary" "$result_env"
  mv -f "$escrow_temporary" "$escrow_json"
  fsync_local_directory "$request_dir"
  chmod 600 "$result_env" "$escrow_json"
  BACKUP_FILE="$(sed -n 's/^NEXUS_BACKUP_FILE=//p' "$result_env" | tail -1)"
  BACKUP_SHA256="$(sed -n 's/^NEXUS_BACKUP_SHA256=//p' "$result_env" | tail -1)"
  CUTOVER_SECONDS="$(sed -n 's/^NEXUS_CUTOVER_SECONDS=//p' "$result_env" | tail -1)"
  BACKUP_WINDOW_SECONDS="$(sed -n 's/^NEXUS_BACKUP_WINDOW_SECONDS=//p' "$result_env" | tail -1)"
  BACKUP_OUTAGE_SECONDS="$(sed -n 's/^NEXUS_BACKUP_OUTAGE_SECONDS=//p' "$result_env" | tail -1)"
  FINAL_UNAVAILABILITY_SECONDS="$(sed -n 's/^NEXUS_FINAL_UNAVAILABILITY_SECONDS=//p' "$result_env" | tail -1)"
  TOTAL_UNAVAILABILITY_SECONDS="$(sed -n 's/^NEXUS_TOTAL_UNAVAILABILITY_SECONDS=//p' "$result_env" | tail -1)"
  VERIFICATION_SOAK_SECONDS="$(sed -n 's/^NEXUS_VERIFICATION_SOAK_SECONDS=//p' "$result_env" | tail -1)"
  RESULT_SENTRY_RELEASE="$(sed -n 's/^NEXUS_SENTRY_RELEASE=//p' "$result_env" | tail -1)"
  RESULT_TRANSACTION_ID="$(sed -n 's/^NEXUS_TRANSACTION_ID=//p' "$result_env" | tail -1)"
  RESULT_RUNTIME_SHA="$(sed -n 's/^NEXUS_RUNTIME_SHA=//p' "$result_env" | tail -1)"
  RESULT_ARTIFACT_DIGEST="$(sed -n 's/^NEXUS_ARTIFACT_DIGEST=//p' "$result_env" | tail -1)"
  RESULT_INSTALLED_RUNTIME_DIGEST="$(sed -n 's/^NEXUS_INSTALLED_RUNTIME_DIGEST=//p' "$result_env" | tail -1)"
  RESULT_CUTOVER_STARTED_AT="$(sed -n 's/^NEXUS_CUTOVER_STARTED_AT=//p' "$result_env" | tail -1)"
  RESULT_SERVICE_UNAVAILABLE_STARTED_AT="$(sed -n 's/^NEXUS_SERVICE_UNAVAILABLE_STARTED_AT=//p' "$result_env" | tail -1)"
  RESULT_CANDIDATE_AVAILABLE_AT="$(sed -n 's/^NEXUS_CANDIDATE_AVAILABLE_AT=//p' "$result_env" | tail -1)"
  RESULT_SOAK_STARTED_AT="$(sed -n 's/^NEXUS_SOAK_STARTED_AT=//p' "$result_env" | tail -1)"
  RESULT_SOAK_COMPLETED_AT="$(sed -n 's/^NEXUS_SOAK_COMPLETED_AT=//p' "$result_env" | tail -1)"
  SOAK_OBSERVED_SECONDS="$(sed -n 's/^NEXUS_SOAK_OBSERVED_SECONDS=//p' "$result_env" | tail -1)"
  [ "$RESULT_TRANSACTION_ID" = "$PROMOTION_RUN_ID" ] \
    && [ "$RESULT_RUNTIME_SHA" = "$RUNTIME_SHA" ] \
    && [ "$RESULT_ARTIFACT_DIGEST" = "$ARTIFACT_DIGEST" ] \
    && [ "$RESULT_INSTALLED_RUNTIME_DIGEST" = "$INSTALLED_RUNTIME_DIGEST" ] \
    && [ "$RESULT_SENTRY_RELEASE" = "$RUNTIME_SHA" ] || {
    echo "transaction result identity does not match the requested release" >&2
    return 1
  }
  case "$BACKUP_FILE" in "$BACKUP_DIR"/v*.tar.gz) ;; *) echo "transaction returned an unsafe backup path" >&2; return 1 ;; esac
  [[ "$BACKUP_SHA256" =~ ^[a-f0-9]{64}$ ]] || { echo "transaction returned an invalid backup digest" >&2; return 1; }
  ESCROW_FIELDS="$(node - "$escrow_json" \
    "$PROMOTION_RUN_ID" "$request_sha" \
    "$BACKUP_FILE" "$BACKUP_SHA256" "$PROD_RELEASE" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" \
    "$INSTALLED_RUNTIME_DIGEST" "$RECOVERY_RUNTIME_DIGEST" "$RELEASE_MANIFEST_SHA256" \
    "$STAGING_ATTESTATION_SHA256" "$RESULT_CUTOVER_STARTED_AT" \
    "$RESULT_SERVICE_UNAVAILABLE_STARTED_AT" "$RESULT_SOAK_COMPLETED_AT" \
    "$TARGET_VERSION" <<'NODE'
const fs=require('fs');const [file,id,requestSha,path,sha,runtime,runtimeSha,artifact,installed,
 recoveryDigest,manifestSha,stagingSha,cutoverStartedAt,serviceUnavailableStartedAt,
 soakCompletedAt,targetVersion]=process.argv.slice(2);
const x=JSON.parse(fs.readFileSync(file,'utf8')),r=x.requiredRelease,c=x.currentRecoveryRuntime,
 p=x.preMutationCurrentRecovery,s=x.storageControls,d0=x.preMutationDatabaseRecoveryPoint,
 d1=x.currentDatabaseRecoveryPoint,t=x.promotionTimeline,
 readiness=x.candidateReadinessRefresh,beforeReadiness=readiness?.beforeEscrow,
 afterReadiness=readiness?.afterEscrow;
const validStoragePair=(s?.provider==='aws-s3'&&s?.controlMode==='versioned-s3')
 ||(s?.provider==='cloudflare-r2'&&s?.controlMode==='r2-approved-variance');
const validAwsVersionId=(value)=>{
 if(typeof value!=='string'||value==='null')return false;
 const encoded=Buffer.from(value,'utf8');
 return encoded.length>=1&&encoded.length<=1024
  &&encoded.toString('utf8')===value&&!/[\u0000-\u001f\u007f]/u.test(value);
};
const providerProof=(value)=>{
 const confirmed=Date.parse(value?.confirmedAt||'');
 if(!Number.isFinite(confirmed))return false;
 if(s?.provider==='aws-s3')return validAwsVersionId(value?.objectVersionId)
  &&Number.isFinite(Date.parse(value?.retainUntil||''))
  &&Date.parse(value.retainUntil)>=confirmed+90*86400*1000
  &&value.retentionVariance===null&&value.approvedUnversionedVariance===false;
 return s?.provider==='cloudflare-r2'&&value?.objectVersionId===null&&value?.retainUntil===null
  &&value?.retentionVariance==='r2-approved-variance'&&value?.approvedUnversionedVariance===true;
};
const databaseProof=(value)=>{
 const confirmed=Date.parse(value?.confirmedAt||'');
 if(!Number.isFinite(confirmed)
   ||typeof value?.objectKey!=='string'||value.objectKey.includes('..')||value.objectKey.includes('//')
   ||!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,900}\/database\/hourly\/nexus-db-\d{8}T\d{6}Z\.sqlite\.age$/u.test(value.objectKey)
   ||!/^[a-f0-9]{64}$/u.test(value?.plaintextSha256||'')
   ||!/^[a-f0-9]{64}$/u.test(value?.encryptedSha256||'')
   ||!Number.isSafeInteger(value?.encryptedSizeBytes)||value.encryptedSizeBytes<=0)return false;
 if(s?.provider==='aws-s3')return validAwsVersionId(value?.objectVersionId)
   &&value.retentionVariance===null&&value.approvedUnversionedVariance===false;
 return s?.provider==='cloudflare-r2'&&value?.objectVersionId===null
   &&value?.retentionVariance==='r2-approved-variance'
   &&value?.approvedUnversionedVariance===true;
};
const d0Confirmed=Date.parse(d0?.confirmedAt||''),d1Confirmed=Date.parse(d1?.confirmedAt||'');
const pConfirmed=Date.parse(p?.confirmedAt||''),cConfirmed=Date.parse(c?.confirmedAt||'');
const cutoverStarted=Date.parse(cutoverStartedAt),serviceUnavailable=Date.parse(serviceUnavailableStartedAt);
const soakCompleted=Date.parse(soakCompletedAt);
const releaseConfirmed=Date.parse(r?.confirmedAt||'');
const beforeReadinessVerified=Date.parse(beforeReadiness?.verifiedAt||'');
const afterReadinessVerified=Date.parse(afterReadiness?.verifiedAt||'');
const readinessProof=(value)=>value?.schema==='nexus.candidate-readiness-refresh.v1'
 &&value?.status==='passed'&&value?.transactionId===id&&value?.runtimeSha===runtimeSha
 &&value?.packageVersion===targetVersion
 &&Object.keys(value?.checks||{}).sort().join(',')==='authenticatedSnapshot,contentEngine,loopbackBackend,pm2Identity,publicHealth'
 &&Object.values(value.checks).every((check)=>check===true);
const stable=['path','plaintextSha256','runtimeSha','artifactDigest',
 'installedRuntimeDigest','recoveryRuntimeDigest','releaseManifestSha256',
 'stagingAttestationSha256','escrowId'];
if(x.schema!=='nexus.promotion-dr-escrow.v3'||x.status!=='passed'||x.transactionId!==id
 ||typeof s?.provider!=='string'||typeof s?.controlMode!=='string'
 ||!validStoragePair
 ||s.releasePrefixLockVerified!==true
 ||x.requestSha256!==requestSha||r?.confirmed!==true||r?.path!==path||r?.plaintextSha256!==sha
 ||!/^[a-f0-9]{64}$/u.test(r?.encryptedSha256||'')
 ||!Number.isSafeInteger(r?.encryptedSizeBytes)||r.encryptedSizeBytes<=0
 ||!providerProof(r)||typeof r?.objectKey!=='string'||!r.objectKey.endsWith(`.${sha}.age`)
 ||r.objectKey.includes('..')||c?.confirmed!==true||c?.escrowId!==id
 ||c?.escrowPhase!=='post-soak'||p?.escrowPhase!=='pre-mutation'
 ||c?.path!==runtime||c?.runtimeSha!==runtimeSha
 ||c?.artifactDigest!==artifact||c?.installedRuntimeDigest!==installed
 ||c?.recoveryRuntimeDigest!==recoveryDigest||c?.releaseManifestSha256!==manifestSha
 ||c?.stagingAttestationSha256!==stagingSha||!/^[a-f0-9]{64}$/u.test(c?.plaintextSha256||'')
 ||!/^[a-f0-9]{64}$/u.test(c?.encryptedSha256||'')
 ||!Number.isSafeInteger(c?.encryptedSizeBytes)||c.encryptedSizeBytes<=0
 ||typeof c?.objectKey!=='string'
 ||!c.objectKey.endsWith(`+escrow-${id}+phase-post-soak.tar.gz.${c.plaintextSha256}.age`)
 ||c.objectKey.includes('..')||!providerProof(c)
 ||typeof p?.objectKey!=='string'
 ||!p.objectKey.endsWith(`+escrow-${id}+phase-pre-mutation.tar.gz.${p.plaintextSha256}.age`)
 ||!/^[a-f0-9]{64}$/u.test(p?.encryptedSha256||'')
 ||!Number.isSafeInteger(p?.encryptedSizeBytes)||p.encryptedSizeBytes<=0
 ||!providerProof(p)
 ||stable.some((field)=>c[field]!==p?.[field])
 ||!databaseProof(d0)||!databaseProof(d1)
 ||![d0Confirmed,d1Confirmed,pConfirmed,cConfirmed,releaseConfirmed,cutoverStarted,
   serviceUnavailable,soakCompleted,beforeReadinessVerified,afterReadinessVerified]
   .every(Number.isFinite)
 ||d0Confirmed>cutoverStarted||d0Confirmed>serviceUnavailable
 ||d1Confirmed<soakCompleted||d1Confirmed<d0Confirmed
 ||pConfirmed>cutoverStarted||pConfirmed>serviceUnavailable
 ||cConfirmed<soakCompleted||cConfirmed<pConfirmed
 ||!readinessProof(beforeReadiness)||!readinessProof(afterReadiness)
 ||beforeReadinessVerified<soakCompleted
 ||releaseConfirmed<beforeReadinessVerified
 ||cConfirmed<beforeReadinessVerified||d1Confirmed<beforeReadinessVerified
 ||afterReadinessVerified<beforeReadinessVerified
 ||afterReadinessVerified<releaseConfirmed
 ||afterReadinessVerified<cConfirmed||afterReadinessVerified<d1Confirmed
 ||t?.cutoverStartedAt!==cutoverStartedAt
 ||t?.serviceUnavailableStartedAt!==serviceUnavailableStartedAt
 ||t?.soakCompletedAt!==soakCompletedAt
 ||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(x.confirmedAt||''))process.exit(1);
const fields=[r.objectKey,r.confirmedAt,r.objectVersionId??'-',r.retainUntil??'-',
 r.encryptedSha256,String(r.encryptedSizeBytes),
 c.objectKey,c.plaintextSha256,c.encryptedSha256,String(c.encryptedSizeBytes),
 c.confirmedAt,c.objectVersionId??'-',c.retainUntil??'-',
 c.escrowId,s.provider,s.controlMode,x.confirmedAt,
 p.objectKey,p.plaintextSha256,p.encryptedSha256,String(p.encryptedSizeBytes),
 p.confirmedAt,p.objectVersionId??'-',p.retainUntil??'-',p.escrowId,
 d0.objectKey,d0.plaintextSha256,d0.confirmedAt,d0.encryptedSha256,
 String(d0.encryptedSizeBytes),d0.objectVersionId??'-',
 d0.retentionVariance??'-',String(d0.approvedUnversionedVariance),
 d1.objectKey,d1.plaintextSha256,d1.confirmedAt,d1.encryptedSha256,
 String(d1.encryptedSizeBytes),d1.objectVersionId??'-',
 d1.retentionVariance??'-',String(d1.approvedUnversionedVariance),
 Buffer.from(JSON.stringify(beforeReadiness)).toString('base64'),
 Buffer.from(JSON.stringify(afterReadiness)).toString('base64')];
process.stdout.write(`${fields.join('\t')}\n`);
NODE
  )" || { echo "authoritative rollback escrow evidence is invalid" >&2; return 1; }
  IFS=$'\t' read -r ESCROW_OBJECT_KEY ROLLBACK_ESCROW_CONFIRMED_AT \
    ESCROW_OBJECT_VERSION_ID ESCROW_RETAIN_UNTIL \
    ROLLBACK_ESCROW_ENCRYPTED_SHA256 ROLLBACK_ESCROW_ENCRYPTED_SIZE_BYTES \
    RECOVERY_ESCROW_OBJECT_KEY RECOVERY_ARCHIVE_SHA256 \
    RECOVERY_ESCROW_ENCRYPTED_SHA256 RECOVERY_ESCROW_ENCRYPTED_SIZE_BYTES \
    RECOVERY_ESCROW_CONFIRMED_AT \
    RECOVERY_OBJECT_VERSION_ID RECOVERY_RETAIN_UNTIL RECOVERY_ESCROW_ID \
    ESCROW_STORAGE_PROVIDER ESCROW_STORAGE_CONTROL_MODE ESCROW_CONFIRMED_AT \
    PRE_RECOVERY_ESCROW_OBJECT_KEY PRE_RECOVERY_ARCHIVE_SHA256 \
    PRE_RECOVERY_ESCROW_ENCRYPTED_SHA256 PRE_RECOVERY_ESCROW_ENCRYPTED_SIZE_BYTES \
    PRE_RECOVERY_ESCROW_CONFIRMED_AT PRE_RECOVERY_OBJECT_VERSION_ID \
    PRE_RECOVERY_RETAIN_UNTIL PRE_RECOVERY_ESCROW_ID \
    PRE_DATABASE_OBJECT_KEY PRE_DATABASE_SHA256 PRE_DATABASE_CONFIRMED_AT \
    PRE_DATABASE_ENCRYPTED_SHA256 PRE_DATABASE_ENCRYPTED_SIZE_BYTES \
    PRE_DATABASE_OBJECT_VERSION_ID PRE_DATABASE_RETENTION_VARIANCE \
    PRE_DATABASE_APPROVED_UNVERSIONED_VARIANCE \
    CURRENT_DATABASE_OBJECT_KEY CURRENT_DATABASE_SHA256 CURRENT_DATABASE_CONFIRMED_AT \
    CURRENT_DATABASE_ENCRYPTED_SHA256 CURRENT_DATABASE_ENCRYPTED_SIZE_BYTES \
    CURRENT_DATABASE_OBJECT_VERSION_ID CURRENT_DATABASE_RETENTION_VARIANCE \
    CURRENT_DATABASE_APPROVED_UNVERSIONED_VARIANCE \
    BEFORE_ESCROW_READINESS_B64 AFTER_ESCROW_READINESS_B64 <<<"$ESCROW_FIELDS" || {
    echo "authoritative rollback escrow evidence fields are invalid" >&2
    return 1
  }
  ESCROW_EVIDENCE_SHA256="$(node -e 'const fs=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$escrow_json")"
  [[ "$CUTOVER_SECONDS" =~ ^[0-9]+$ ]] || { echo "transaction returned invalid cutover duration" >&2; return 1; }
  [[ "$BACKUP_WINDOW_SECONDS" =~ ^[0-9]+$ && "$BACKUP_OUTAGE_SECONDS" = "$BACKUP_WINDOW_SECONDS" ]] || {
    echo "transaction returned invalid single-outage backup evidence" >&2
    return 1
  }
  [[ "$FINAL_UNAVAILABILITY_SECONDS" =~ ^[0-9]+$ \
      && "$TOTAL_UNAVAILABILITY_SECONDS" =~ ^[0-9]+$ \
      && "$SOAK_OBSERVED_SECONDS" =~ ^[0-9]+$ \
      && "$VERIFICATION_SOAK_SECONDS" = 60 ]] || {
    echo "transaction returned invalid unavailability or soak evidence" >&2
    return 1
  }
  [ "$SOAK_OBSERVED_SECONDS" -ge "$VERIFICATION_SOAK_SECONDS" ] \
    && [ "$SOAK_OBSERVED_SECONDS" -le 180 ] || {
    echo "transaction did not prove the configured stability soak" >&2
    return 1
  }
  [ "$TOTAL_UNAVAILABILITY_SECONDS" -eq "$FINAL_UNAVAILABILITY_SECONDS" ] || {
    echo "transaction unavailability evidence is inconsistent" >&2
    return 1
  }
  [ "$TOTAL_UNAVAILABILITY_SECONDS" -le 60 ] \
    && [[ "$RESULT_CUTOVER_STARTED_AT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ \
      && "$RESULT_SERVICE_UNAVAILABLE_STARTED_AT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ \
      && "$RESULT_CANDIDATE_AVAILABLE_AT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ \
      && "$RESULT_SOAK_STARTED_AT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ \
      && "$RESULT_SOAK_COMPLETED_AT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || {
    echo "transaction violated the bounded unavailability contract" >&2
    return 1
  }
  node -e '
    const [started,completed]=process.argv.slice(1),a=Date.parse(started),b=Date.parse(completed);
    if(!Number.isFinite(a)||!Number.isFinite(b)||b<a)process.exit(1);' \
    "$RESULT_SOAK_STARTED_AT" "$RESULT_SOAK_COMPLETED_AT" || {
    echo "transaction returned invalid soak timestamps" >&2
    return 1
  }

  # A journal saying completed is insufficient after a disconnect. Re-prove
  # the live symlink and both PM2 process identities before writing local
  # production evidence or treating a retry as successful.
  "${SSH[@]}" "$SERVER" bash -s -- "$PROD_BASE" "$PROD_RELEASE" "$RUNTIME_SHA" \
    "$ARTIFACT_DIGEST" "$INSTALLED_RUNTIME_DIGEST" "$RECOVERY_RUNTIME_DIGEST" \
    "$REMOTE_PM2" <<'REMOTE_COMPLETED_IDENTITY'
set -euo pipefail
base_dir="$1"; release_dir="$2"; runtime_sha="$3"; artifact_digest="$4"; installed_digest="$5"; recovery_digest="$6"; pm2_bin="$7"
[ "$(id -u)" -ne 0 ] || { echo "completed recovery identity verification must be unprivileged" >&2; exit 1; }
[ "$(readlink -f "$base_dir/current")" = "$release_dir" ] || { echo "completed promotion current symlink mismatch" >&2; exit 1; }
[ -f "$release_dir/.complete.json" ] || { echo "completed promotion marker is missing" >&2; exit 1; }
node -e 'const x=require(process.argv[1]);if(x.runtimeSha!==process.argv[2])process.exit(1)' "$release_dir/.complete.json" "$runtime_sha"
node "$release_dir/scripts/release-installed-tree-attestation.mjs" validate \
  --root "$release_dir" --runtime-sha "$runtime_sha" --artifact-digest "$artifact_digest" \
  --expect-runtime-sha "$runtime_sha" --expect-artifact-digest "$artifact_digest" \
  --expect-aggregate-digest "$installed_digest" >/dev/null
node "$release_dir/scripts/release-recovery-runtime-identity.mjs" compute \
  --root "$release_dir" --runtime-sha "$runtime_sha" --artifact-digest "$artifact_digest" \
  --expect-digest "$recovery_digest" >/dev/null
timeout 5s "$pm2_bin" jlist | node -e '
const fs=require("fs");const rows=JSON.parse(fs.readFileSync(0,"utf8"));const root=process.argv[1],sha=process.argv[2];
for(const [name,cwd] of [["nexus-hub",root],["content-engine",`${root}/content-engine`]]){
  const row=rows.find((entry)=>entry?.name===name),env=row?.pm2_env??{};
  if(env.status!=="online"||env.pm_cwd!==cwd||(env.NEXUS_RELEASE_SHA||env.GIT_COMMIT)!==sha||env.SENTRY_RELEASE!==sha)process.exit(1);
}' "$release_dir" "$runtime_sha"
REMOTE_COMPLETED_IDENTITY

  SYSTEMD_RESULT_PATH="$ROOT/.local/release/production/${RUNTIME_SHA}-${ARTIFACT_DIGEST}.json"
  for evidence_directory in \
    "$ROOT/.local" \
    "$ROOT/.local/release" \
    "$ROOT/.local/release/production"; do
    if [ -e "$evidence_directory" ] || [ -L "$evidence_directory" ]; then
      [ -d "$evidence_directory" ] && [ ! -L "$evidence_directory" ] || {
        echo "local production evidence directory is unsafe: $evidence_directory" >&2
        return 1
      }
    else
      mkdir "$evidence_directory"
    fi
    chmod 700 "$evidence_directory"
  done
  node - "$SYSTEMD_RESULT_PATH" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$INSTALLED_RUNTIME_DIGEST" \
    "$RECOVERY_RUNTIME_DIGEST" "$RELEASE_MANIFEST_SHA256" "$STAGING_ATTESTATION_SHA256" \
    "$BACKUP_FILE" "$BACKUP_SHA256" "$ESCROW_OBJECT_KEY" \
    "$ROLLBACK_ESCROW_CONFIRMED_AT" "$ESCROW_OBJECT_VERSION_ID" "$ESCROW_RETAIN_UNTIL" \
    "$ROLLBACK_ESCROW_ENCRYPTED_SHA256" "$ROLLBACK_ESCROW_ENCRYPTED_SIZE_BYTES" \
    "$RECOVERY_ESCROW_OBJECT_KEY" "$RECOVERY_ARCHIVE_SHA256" \
    "$RECOVERY_ESCROW_ENCRYPTED_SHA256" "$RECOVERY_ESCROW_ENCRYPTED_SIZE_BYTES" \
    "$RECOVERY_ESCROW_CONFIRMED_AT" \
    "$RECOVERY_OBJECT_VERSION_ID" "$RECOVERY_RETAIN_UNTIL" "$RECOVERY_ESCROW_ID" \
    "$ESCROW_STORAGE_PROVIDER" "$ESCROW_STORAGE_CONTROL_MODE" \
    "$ESCROW_CONFIRMED_AT" "$ESCROW_EVIDENCE_SHA256" \
    "$PRE_RECOVERY_ESCROW_OBJECT_KEY" "$PRE_RECOVERY_ARCHIVE_SHA256" \
    "$PRE_RECOVERY_ESCROW_ENCRYPTED_SHA256" "$PRE_RECOVERY_ESCROW_ENCRYPTED_SIZE_BYTES" \
    "$PRE_RECOVERY_ESCROW_CONFIRMED_AT" "$PRE_RECOVERY_OBJECT_VERSION_ID" \
    "$PRE_RECOVERY_RETAIN_UNTIL" "$PRE_RECOVERY_ESCROW_ID" \
    "$PRE_DATABASE_OBJECT_KEY" "$PRE_DATABASE_SHA256" "$PRE_DATABASE_CONFIRMED_AT" \
    "$PRE_DATABASE_ENCRYPTED_SHA256" "$PRE_DATABASE_ENCRYPTED_SIZE_BYTES" \
    "$PRE_DATABASE_OBJECT_VERSION_ID" "$PRE_DATABASE_RETENTION_VARIANCE" \
    "$PRE_DATABASE_APPROVED_UNVERSIONED_VARIANCE" \
    "$CURRENT_DATABASE_OBJECT_KEY" "$CURRENT_DATABASE_SHA256" "$CURRENT_DATABASE_CONFIRMED_AT" \
    "$CURRENT_DATABASE_ENCRYPTED_SHA256" "$CURRENT_DATABASE_ENCRYPTED_SIZE_BYTES" \
    "$CURRENT_DATABASE_OBJECT_VERSION_ID" "$CURRENT_DATABASE_RETENTION_VARIANCE" \
    "$CURRENT_DATABASE_APPROVED_UNVERSIONED_VARIANCE" \
    "$RESULT_CUTOVER_STARTED_AT" "$RESULT_SERVICE_UNAVAILABLE_STARTED_AT" \
    "$RESULT_CANDIDATE_AVAILABLE_AT" "$RESULT_SOAK_STARTED_AT" "$RESULT_SOAK_COMPLETED_AT" \
    "$CUTOVER_SECONDS" "$BACKUP_WINDOW_SECONDS" "$BACKUP_OUTAGE_SECONDS" \
    "$FINAL_UNAVAILABILITY_SECONDS" "$TOTAL_UNAVAILABILITY_SECONDS" "$VERIFICATION_SOAK_SECONDS" \
    "$SOAK_OBSERVED_SECONDS" "$BEFORE_ESCROW_READINESS_B64" "$AFTER_ESCROW_READINESS_B64" \
    "$TARGET_VERSION" "$PUBLIC_BASE_URL" "$PROMOTION_RUN_ID" <<'NODE'
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const [file, runtimeSha, artifactDigest, installedRuntimeDigest, recoveryRuntimeDigest,
  releaseManifestSha256, stagingAttestationSha256,
  exactBackup, backupSha256, escrowObjectKey, rollbackEscrowConfirmedAt,
  escrowObjectVersionId, escrowRetainUntil, rollbackEscrowEncryptedSha256,
  rollbackEscrowEncryptedSizeBytes, recoveryEscrowObjectKey, recoveryArchiveSha256,
  recoveryEscrowEncryptedSha256, recoveryEscrowEncryptedSizeBytes,
  recoveryEscrowConfirmedAt, recoveryObjectVersionId, recoveryRetainUntil, recoveryEscrowId,
  escrowStorageProvider, escrowStorageControlMode, escrowConfirmedAt, escrowEvidenceSha256,
  preRecoveryEscrowObjectKey, preRecoveryArchiveSha256,
  preRecoveryEscrowEncryptedSha256, preRecoveryEscrowEncryptedSizeBytes,
  preRecoveryEscrowConfirmedAt, preRecoveryObjectVersionId,
  preRecoveryRetainUntil, preRecoveryEscrowId,
  preDatabaseObjectKey, preDatabaseSha256, preDatabaseConfirmedAt,
  preDatabaseEncryptedSha256, preDatabaseEncryptedSizeBytes,
  preDatabaseObjectVersionId, preDatabaseRetentionVariance,
  preDatabaseApprovedUnversionedVariance,
  currentDatabaseObjectKey, currentDatabaseSha256, currentDatabaseConfirmedAt,
  currentDatabaseEncryptedSha256, currentDatabaseEncryptedSizeBytes,
  currentDatabaseObjectVersionId, currentDatabaseRetentionVariance,
  currentDatabaseApprovedUnversionedVariance,
  budgetStartedAt, serviceUnavailableStartedAt,
  candidateAvailableAt, soakStartedAt, soakCompletedAt, cutoverSeconds, backupWindowSeconds, backupOutageSeconds,
  finalUnavailabilitySeconds, totalUnavailabilitySeconds, verificationSoakSeconds, soakObservedSeconds,
  beforeEscrowReadinessB64, afterEscrowReadinessB64,
  packageVersion, publicBaseUrl, transactionId] = process.argv.slice(2);
const beforeEscrowReadiness=JSON.parse(Buffer.from(beforeEscrowReadinessB64,'base64').toString('utf8'));
const afterEscrowReadiness=JSON.parse(Buffer.from(afterEscrowReadinessB64,'base64').toString('utf8'));
const body=`${JSON.stringify({
  schema: 'nexus.production-promotion-evidence.v1', status: 'passed', runtimeSha, artifactDigest,
  installedRuntimeDigest, recoveryRuntimeDigest,
  releaseManifestSha256, stagingAttestationSha256,
  exactBackup, startedAt: budgetStartedAt, serviceUnavailableStartedAt, candidateAvailableAt,
  soakStartedAt, soakCompletedAt,
  completedAt: afterEscrowReadiness.verifiedAt, cutoverSeconds: Number(cutoverSeconds),
  backupSha256,
  drEscrowConfirmedAt: escrowConfirmedAt,
  drStorageControls: {
    provider: escrowStorageProvider,
    controlMode: escrowStorageControlMode,
    releasePrefixLockVerified: true,
  },
  rollbackEscrow: {
    status: 'passed',
    provider: escrowStorageProvider,
    objectKey: escrowObjectKey,
    confirmedAt: rollbackEscrowConfirmedAt,
    objectVersionId: escrowObjectVersionId === '-' ? null : escrowObjectVersionId,
    retainUntil: escrowRetainUntil === '-' ? null : escrowRetainUntil,
    encryptedSha256: rollbackEscrowEncryptedSha256,
    encryptedSizeBytes: Number(rollbackEscrowEncryptedSizeBytes),
    evidenceSha256: escrowEvidenceSha256,
  },
  currentRecoveryEscrow: { status: 'passed', objectKey: recoveryEscrowObjectKey,
    provider: escrowStorageProvider,
    runtimeSha, artifactDigest, installedRuntimeDigest, recoveryRuntimeDigest,
    escrowId: recoveryEscrowId,
    escrowPhase: 'post-soak',
    plaintextSha256: recoveryArchiveSha256,
    encryptedSha256: recoveryEscrowEncryptedSha256,
    encryptedSizeBytes: Number(recoveryEscrowEncryptedSizeBytes),
    confirmedAt: recoveryEscrowConfirmedAt,
    objectVersionId: recoveryObjectVersionId === '-' ? null : recoveryObjectVersionId,
    retainUntil: recoveryRetainUntil === '-' ? null : recoveryRetainUntil,
    evidenceSha256: escrowEvidenceSha256 },
  preMutationCurrentRecoveryEscrow: {
    status: 'passed',
    objectKey: preRecoveryEscrowObjectKey,
    provider: escrowStorageProvider,
    runtimeSha, artifactDigest, installedRuntimeDigest, recoveryRuntimeDigest,
    escrowId: preRecoveryEscrowId,
    escrowPhase: 'pre-mutation',
    plaintextSha256: preRecoveryArchiveSha256,
    encryptedSha256: preRecoveryEscrowEncryptedSha256,
    encryptedSizeBytes: Number(preRecoveryEscrowEncryptedSizeBytes),
    confirmedAt: preRecoveryEscrowConfirmedAt,
    objectVersionId: preRecoveryObjectVersionId === '-' ? null : preRecoveryObjectVersionId,
    retainUntil: preRecoveryRetainUntil === '-' ? null : preRecoveryRetainUntil,
    evidenceSha256: escrowEvidenceSha256,
  },
  preMutationDatabaseRecoveryPoint: {
    status: 'passed',
    provider: escrowStorageProvider,
    objectKey: preDatabaseObjectKey,
    plaintextSha256: preDatabaseSha256,
    encryptedSha256: preDatabaseEncryptedSha256,
    encryptedSizeBytes: Number(preDatabaseEncryptedSizeBytes),
    confirmedAt: preDatabaseConfirmedAt,
    objectVersionId: preDatabaseObjectVersionId === '-' ? null : preDatabaseObjectVersionId,
    retentionVariance: preDatabaseRetentionVariance === '-' ? null : preDatabaseRetentionVariance,
    approvedUnversionedVariance: preDatabaseApprovedUnversionedVariance === 'true',
    evidenceSha256: escrowEvidenceSha256,
  },
  currentDatabaseRecoveryPoint: {
    status: 'passed',
    provider: escrowStorageProvider,
    objectKey: currentDatabaseObjectKey,
    plaintextSha256: currentDatabaseSha256,
    encryptedSha256: currentDatabaseEncryptedSha256,
    encryptedSizeBytes: Number(currentDatabaseEncryptedSizeBytes),
    confirmedAt: currentDatabaseConfirmedAt,
    objectVersionId: currentDatabaseObjectVersionId === '-' ? null : currentDatabaseObjectVersionId,
    retentionVariance: currentDatabaseRetentionVariance === '-' ? null : currentDatabaseRetentionVariance,
    approvedUnversionedVariance: currentDatabaseApprovedUnversionedVariance === 'true',
    evidenceSha256: escrowEvidenceSha256,
  },
  backupWindowSeconds: Number(backupWindowSeconds),
  backupOutageSeconds: Number(backupOutageSeconds),
  finalUnavailabilitySeconds: Number(finalUnavailabilitySeconds),
  totalUnavailabilitySeconds: Number(totalUnavailabilitySeconds),
  verificationSoakSeconds: Number(verificationSoakSeconds),
  soakObservedSeconds: Number(soakObservedSeconds),
  sentryRelease: runtimeSha,
  packageVersion, transactionId, transactionMode: 'systemd_oneshot',
  candidateReadinessRefresh: {
    beforeEscrow: beforeEscrowReadiness,
    afterEscrow: afterEscrowReadiness,
  },
  verification: {
    loopbackBackend: afterEscrowReadiness.checks.loopbackBackend,
    contentEngineHealth: afterEscrowReadiness.checks.contentEngine,
    authenticatedContentEngine: afterEscrowReadiness.checks.authenticatedSnapshot,
    pm2AndCurrentIdentity: afterEscrowReadiness.checks.pm2Identity,
    publicHealth: {
      baseUrl: publicBaseUrl,
      status: afterEscrowReadiness.checks.publicHealth ? 'healthy' : 'failed',
      database: afterEscrowReadiness.checks.publicHealth ? 'connected' : 'unknown',
    },
    publicSnapshotVersion: afterEscrowReadiness.checks.authenticatedSnapshot
      ? afterEscrowReadiness.packageVersion : null,
  },
}, null, 2)}\n`;
const expected=Buffer.from(body),parent=path.dirname(file);
const prefix=`.${path.basename(file)}.next.`;
const parentStat=fs.lstatSync(parent);
if(!parentStat.isDirectory()||parentStat.isSymbolicLink()
  ||(parentStat.mode&0o777)!==0o700
  ||path.dirname(path.resolve(file))!==path.resolve(parent))process.exit(1);
const lstat=(candidate)=>{
  try{return fs.lstatSync(candidate);}
  catch(error){if(error?.code==='ENOENT')return null;throw error;}
};
const fsyncParent=()=>{
  const descriptor=fs.openSync(parent,'r');
  try{fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
};
const validateExisting=()=>{
  let stat=lstat(file);
  if(!stat||!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o600
    ||!fs.readFileSync(file).equals(expected))process.exit(1);
  if(stat.nlink>1){
    let removed=false;
    for(const name of fs.readdirSync(parent)){
      if(!name.startsWith(prefix))continue;
      const candidate=path.join(parent,name),candidateStat=lstat(candidate);
      if(!candidateStat||!candidateStat.isFile()||candidateStat.isSymbolicLink()
        ||candidateStat.dev!==stat.dev||candidateStat.ino!==stat.ino
        ||!fs.readFileSync(candidate).equals(expected))continue;
      fs.unlinkSync(candidate);
      removed=true;
    }
    if(removed)fsyncParent();
    stat=fs.lstatSync(file);
  }
  if(stat.nlink!==1)process.exit(1);
};
if(lstat(file)){
  validateExisting();
}else{
  const temporary=path.join(
    parent,`${prefix}${process.pid}.${crypto.randomBytes(12).toString('hex')}`,
  );
  let descriptor;
  try{
    descriptor=fs.openSync(temporary,'wx',0o600);
    fs.writeFileSync(descriptor,expected);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor=undefined;
    try{fs.linkSync(temporary,file);fsyncParent();}
    catch(error){if(error?.code!=='EEXIST')throw error;validateExisting();}
    fs.unlinkSync(temporary);
    fsyncParent();
    validateExisting();
  }finally{
    if(descriptor!==undefined)fs.closeSync(descriptor);
  }
}
NODE
  fsync_local_directory "$ROOT/.local/release/production"
  printf '{"ok":true,"runtimeSha":"%s","artifactDigest":"%s","installedRuntimeDigest":"%s","cutoverSeconds":%s,"backupWindowSeconds":%s,"backupOutageSeconds":%s,"finalUnavailabilitySeconds":%s,"totalUnavailabilitySeconds":%s,"verificationSoakSeconds":%s,"soakObservedSeconds":%s,"sentryRelease":"%s","exactBackup":"%s","backupSha256":"%s","escrowObjectKey":"%s","transactionId":"%s","transactionMode":"systemd_oneshot"}\n' \
    "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$INSTALLED_RUNTIME_DIGEST" "$CUTOVER_SECONDS" "$BACKUP_WINDOW_SECONDS" "$BACKUP_OUTAGE_SECONDS" "$FINAL_UNAVAILABILITY_SECONDS" "$TOTAL_UNAVAILABILITY_SECONDS" "$VERIFICATION_SOAK_SECONDS" "$SOAK_OBSERVED_SECONDS" "$RUNTIME_SHA" "$BACKUP_FILE" "$BACKUP_SHA256" "$ESCROW_OBJECT_KEY" "$PROMOTION_RUN_ID"
}

if [ "$SYSTEMD_TRANSACTION_AVAILABLE" = true ]; then
  run_systemd_transaction
  exit 0
fi

restart_previous() {
  echo "legacy predecessor restart is retired; use the root-owned recovery transaction" >&2
  return 77
  "${SSH[@]}" "$SERVER" bash -s -- "$CURRENT_RUNTIME" "$PROD_BASE" "$REMOTE_PM2" <<'REMOTE_RESTART'
set -euo pipefail
runtime="$1"; base_dir="$2"; pm2_bin="$3"
[ -x "$pm2_bin" ] || { echo "PM2 is unavailable for predecessor restart" >&2; exit 1; }
previous_sha=""
for app in nexus-hub content-engine; do
  if "$pm2_bin" describe "$app" >/dev/null 2>&1; then "$pm2_bin" delete "$app" >/dev/null; fi
done
if [ "$runtime" != "$base_dir" ] && [ -f "$runtime/ecosystem.release.config.js" ]; then
  echo "legacy selector mutation is retired; use the root-owned promotion transaction" >&2
  exit 77
  previous_sha="$(node -e 'const fs=require("fs");const p=process.argv[1];process.stdout.write(JSON.parse(fs.readFileSync(p,"utf8")).runtimeSha||"")' "$runtime/.complete.json")"
  [[ "$previous_sha" =~ ^[0-9a-f]{40}$ ]] || { echo "previous runtime SHA is invalid" >&2; exit 1; }
  env -i HOME="$HOME" PATH="$PATH" NEXUS_RELEASE_DIR="$runtime" NEXUS_RELEASE_BASE_DIR="$base_dir" \
    NEXUS_RELEASE_ROLE=production NEXUS_RELEASE_SHA="$previous_sha" \
    "$pm2_bin" start "$runtime/ecosystem.release.config.js" --update-env
else
  echo "legacy base-runtime restart is retired; use the root-owned promotion transaction" >&2
  exit 77
fi

health_file="$(mktemp)"
cleanup_restart() { rm -f "$health_file"; }
trap cleanup_restart EXIT
backend_ok=false; content_ok=false; identity_ok=false
for _ in $(seq 1 15); do
  backend_ok=false; content_ok=false; identity_ok=false
  if curl --fail --silent --show-error --connect-timeout 1 --max-time 5 \
      http://127.0.0.1:8200/health > "$health_file" \
      && node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(x.status!=="healthy"||x.server?.status!=="online"||x.database!=="connected")process.exit(1)' "$health_file"; then
    backend_ok=true
  fi
  if curl --fail --silent --show-error --connect-timeout 1 --max-time 5 \
      http://127.0.0.1:8100/health >/dev/null; then
    content_ok=true
  fi
  if "$pm2_bin" jlist | node -e '
    const fs=require("fs");const rows=JSON.parse(fs.readFileSync(0,"utf8"));
    const root=process.argv[1],sha=process.argv[2];
    for(const [name,cwd] of [["nexus-hub",root],["content-engine",`${root}/content-engine`]]){
      const row=rows.find((entry)=>entry?.name===name),env=row?.pm2_env??{};
      if(env.status!=="online"||env.pm_cwd!==cwd||(sha&&(env.NEXUS_RELEASE_SHA||env.GIT_COMMIT)!==sha))process.exit(1);
    }' "$runtime" "$previous_sha"; then
    if { [ "$runtime" = "$base_dir" ] && [ ! -e "$base_dir/current" ]; } \
        || { [ "$runtime" != "$base_dir" ] && [ "$(readlink -f "$base_dir/current")" = "$runtime" ]; }; then
      identity_ok=true
    fi
  fi
  if [ "$backend_ok" = true ] && [ "$content_ok" = true ] && [ "$identity_ok" = true ]; then
    "$pm2_bin" save >/dev/null
    exit 0
  fi
  sleep 2
done
echo "previous runtime restart failed readiness: backend=$backend_ok content=$content_ok identity=$identity_ok" >&2
exit 1
REMOTE_RESTART
}

restore_exact_backup() {
  echo "legacy exact backup restore is retired; use the root-owned recovery transaction" >&2
  return 77
  "${SSH[@]}" "$SERVER" bash -s -- "$BACKUP_FILE" "$BACKUP_DIR" "$CURRENT_RUNTIME" "$PROD_BASE" "$REMOTE_PM2" <<'REMOTE_RESTORE_EXACT'
set -euo pipefail
backup_file="$1"; backup_dir="$2"; previous_runtime="$3"; base_dir="$4"; pm2_bin="$5"
case "$backup_file" in "$backup_dir"/v*.tar.gz) ;; *) echo "unsafe exact rollback backup" >&2; exit 1 ;; esac
case "$previous_runtime" in "$base_dir"|"$base_dir"/releases/*) ;; *) echo "unsafe previous runtime" >&2; exit 1 ;; esac
[ -f "$backup_file" ] || { echo "exact rollback backup is missing" >&2; exit 1; }
[ -x "$pm2_bin" ] || { echo "PM2 is unavailable for exact rollback" >&2; exit 1; }
previous_sha=""
if [ "$previous_runtime" != "$base_dir" ]; then
  [ -f "$previous_runtime/.complete.json" ] || { echo "previous versioned runtime marker is missing" >&2; exit 1; }
  [ -f "$previous_runtime/ecosystem.release.config.js" ] || { echo "previous versioned runtime config is missing" >&2; exit 1; }
  previous_sha="$(node -e 'const x=require(process.argv[1]);process.stdout.write(x.runtimeSha)' "$previous_runtime/.complete.json")"
  [[ "$previous_sha" =~ ^[0-9a-f]{40}$ ]] || { echo "previous versioned runtime SHA is invalid" >&2; exit 1; }
else
  [ -f "$base_dir/ecosystem.config.js" ] || { echo "previous legacy runtime config is missing" >&2; exit 1; }
fi
for app in nexus-hub content-engine; do
  if "$pm2_bin" describe "$app" >/dev/null 2>&1; then "$pm2_bin" stop "$app" >/dev/null; fi
done
"$pm2_bin" jlist | node -e '
const fs=require("fs");const rows=JSON.parse(fs.readFileSync(0,"utf8"));
for(const name of ["nexus-hub","content-engine"]){const row=rows.find((entry)=>entry?.name===name);
if(row&&(row.pm2_env?.status!=="stopped"||Number(row.pid||0)!==0))throw new Error(`rollback process did not stop: ${name}`)}'
stage="$(mktemp -d "$base_dir/data/.exact-rollback-XXXXXX")"
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT
if tar tzf "$backup_file" | awk '/^\// || /(^|\/)\.\.($|\/)/ { bad=1 } END { exit bad ? 0 : 1 }'; then
  echo "unsafe path in exact rollback backup" >&2
  exit 1
fi
tar xzf "$backup_file" -C "$stage" --wildcards 'data/*'
[ -f "$stage/data/bot.db" ] || { echo "exact rollback database is missing" >&2; exit 1; }
NODE_PATH="$previous_runtime/node_modules" node - "$stage/data/bot.db" <<'NODE'
const Database = require('better-sqlite3');
const db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
try {
  const integrity = db.pragma('integrity_check');
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw new Error('rollback database integrity failed');
  if (db.pragma('foreign_key_check').length !== 0) throw new Error('rollback database foreign key check failed');
} finally { db.close(); }
NODE
install -d -m 700 "$base_dir/data"
for name in bot.db bot.db-wal bot.db-shm; do
  rm -f "$base_dir/data/$name.rollback-next"
  if [ -f "$stage/data/$name" ]; then
    cp -p "$stage/data/$name" "$base_dir/data/$name.rollback-next"
  fi
done
rm -f "$base_dir/data/bot.db" "$base_dir/data/bot.db-wal" "$base_dir/data/bot.db-shm"
for name in bot.db bot.db-wal bot.db-shm; do
  [ ! -f "$base_dir/data/$name.rollback-next" ] || mv "$base_dir/data/$name.rollback-next" "$base_dir/data/$name"
done
rm -rf "$base_dir/data/garmin-tokens"
[ ! -d "$stage/data/garmin-tokens" ] || cp -a "$stage/data/garmin-tokens" "$base_dir/data/garmin-tokens"
for app in nexus-hub content-engine; do
  if "$pm2_bin" describe "$app" >/dev/null 2>&1; then "$pm2_bin" delete "$app" >/dev/null; fi
done
if [ "$previous_runtime" != "$base_dir" ]; then
  echo "legacy exact rollback selector mutation is retired" >&2
  exit 77
  env -i HOME="$HOME" PATH="$PATH" NEXUS_RELEASE_DIR="$previous_runtime" NEXUS_RELEASE_BASE_DIR="$base_dir" \
    NEXUS_RELEASE_ROLE=production NEXUS_RELEASE_SHA="$previous_sha" \
    "$pm2_bin" start "$previous_runtime/ecosystem.release.config.js" --update-env
else
  cd "$base_dir"
  "$pm2_bin" start "$base_dir/ecosystem.config.js" --update-env
fi
health_file="$(mktemp)"
cleanup() { rm -rf "$stage"; rm -f "$health_file"; }
trap cleanup EXIT
backend_ok=false; content_ok=false; identity_ok=false
for _ in $(seq 1 15); do
  backend_ok=false; content_ok=false; identity_ok=false
  if curl --fail --silent --show-error --connect-timeout 1 --max-time 5 \
      http://127.0.0.1:8200/health > "$health_file" \
      && node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(x.status!=="healthy"||x.server?.status!=="online"||x.database!=="connected")process.exit(1)' "$health_file"; then
    backend_ok=true
  fi
  if curl --fail --silent --show-error --connect-timeout 1 --max-time 5 \
      http://127.0.0.1:8100/health >/dev/null; then
    content_ok=true
  fi
  if "$pm2_bin" jlist | node -e '
    const fs=require("fs");const rows=JSON.parse(fs.readFileSync(0,"utf8"));
    const root=process.argv[1],sha=process.argv[2];
    for(const [name,cwd] of [["nexus-hub",root],["content-engine",`${root}/content-engine`]]){
      const row=rows.find((entry)=>entry?.name===name),env=row?.pm2_env??{};
      if(env.status!=="online"||env.pm_cwd!==cwd||(sha&&(env.NEXUS_RELEASE_SHA||env.GIT_COMMIT)!==sha))process.exit(1);
    }' "$previous_runtime" "$previous_sha"; then
    if { [ "$previous_runtime" = "$base_dir" ] && [ ! -e "$base_dir/current" ]; } \
        || { [ "$previous_runtime" != "$base_dir" ] && [ "$(readlink -f "$base_dir/current")" = "$previous_runtime" ]; }; then
      identity_ok=true
    fi
  fi
  if [ "$backend_ok" = true ] && [ "$content_ok" = true ] && [ "$identity_ok" = true ]; then
    "$pm2_bin" save >/dev/null
    exit 0
  fi
  sleep 2
done
echo "exact previous runtime failed readiness after rollback: backend=$backend_ok content=$content_ok identity=$identity_ok" >&2
exit 1
REMOTE_RESTORE_EXACT
}

CUTOVER_TOUCHED=false
CANDIDATE_MUTATED=false
RECOVERY_COMPLETE=false
BACKUP_FILE=""
promotion_exit_handler() {
  local status=$?
  local recovery_status=0
  trap - EXIT INT TERM HUP
  if [ "$status" -ne 0 ] && [ "$CUTOVER_TOUCHED" = true ] && [ "$RECOVERY_COMPLETE" = false ]; then
    set +e
    if [ "$CANDIDATE_MUTATED" = true ] && [ -n "$BACKUP_FILE" ]; then
      echo "promotion failed after candidate mutation; restoring exact backup $BACKUP_FILE" >&2
      restore_exact_backup
      recovery_status=$?
    else
      echo "promotion failed after production stop began; restarting the untouched predecessor" >&2
      restart_previous
      recovery_status=$?
    fi
    set -e
    if [ "$recovery_status" -ne 0 ]; then
      echo "CRITICAL: automatic predecessor recovery failed with status $recovery_status" >&2
    else
      RECOVERY_COMPLETE=true
    fi
  fi
  release_cleanup_all_locks
  if [ "$status" -eq 0 ] && [ "$recovery_status" -ne 0 ]; then status="$recovery_status"; fi
  exit "$status"
}
trap promotion_exit_handler EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

CUTOVER_STARTED_EPOCH="$(date +%s)"
# Recheck immediately before the first stop, after bundle copy and live backup
# preparation, so even a non-cooperating manual PM2/current change fails while
# production is still online.
verify_active_runtime
CUTOVER_TOUCHED=true
"${SSH[@]}" "$SERVER" bash -s -- "$REMOTE_PM2" <<'REMOTE_STOP'
set -euo pipefail
pm2_bin="$1"
for app in nexus-hub content-engine; do
  if "$pm2_bin" describe "$app" >/dev/null 2>&1; then "$pm2_bin" stop "$app" >/dev/null; fi
done
"$pm2_bin" jlist | node -e '
const fs = require("fs");
const rows = JSON.parse(fs.readFileSync(0, "utf8"));
for (const name of ["nexus-hub", "content-engine"]) {
  const row = rows.find((entry) => entry?.name === name);
  if (row && (row.pm2_env?.status !== "stopped" || Number(row.pid || 0) !== 0)) {
    throw new Error(`PM2 process did not stop: ${name}`);
  }
}'
REMOTE_STOP

set +e
BACKUP_OUTPUT="$("${SSH[@]}" "$SERVER" bash -s -- \
  "$CURRENT_RUNTIME" "$BACKUP_DIR" "$TARGET_VERSION" "$REMOTE_PM2" "nexus-hub,content-engine" "$PREPARED_RUNTIME_DIR" \
  < "$ROOT/scripts/remote-create-release-backup.sh" 2>&1)"
BACKUP_EXIT=$?
set -e
printf '%s\n' "$BACKUP_OUTPUT"
if [ "$BACKUP_EXIT" -ne 0 ]; then
  echo "exact stopped-state backup failed" >&2
  exit "$BACKUP_EXIT"
fi
BACKUP_FILE="$(printf '%s\n' "$BACKUP_OUTPUT" | sed -n 's/^NEXUS_BACKUP_FILE=//p' | tail -1)"
BACKUP_SHA256="$(printf '%s\n' "$BACKUP_OUTPUT" | sed -n 's/^NEXUS_BACKUP_SHA256=//p' | tail -1)"
BACKUP_SIZE_BYTES="$(printf '%s\n' "$BACKUP_OUTPUT" | sed -n 's/^NEXUS_BACKUP_SIZE_BYTES=//p' | tail -1)"
BACKUP_ARCHIVED_VERSION="$(printf '%s\n' "$BACKUP_OUTPUT" | sed -n 's/^NEXUS_BACKUP_ARCHIVED_VERSION=//p' | tail -1)"
BACKUP_TARGET_VERSION="$(printf '%s\n' "$BACKUP_OUTPUT" | sed -n 's/^NEXUS_BACKUP_TARGET_VERSION=//p' | tail -1)"
BACKUP_CREATED_AT="$(printf '%s\n' "$BACKUP_OUTPUT" | sed -n 's/^NEXUS_BACKUP_CREATED_AT=//p' | tail -1)"
BACKUP_DATABASE_SHA256="$(printf '%s\n' "$BACKUP_OUTPUT" | sed -n 's/^NEXUS_BACKUP_DATABASE_SHA256=//p' | tail -1)"
case "$BACKUP_FILE" in
  /home/dominguez/backups/nexushub/v*.tar.gz) ;;
  *) echo "backup helper returned an unsafe path" >&2; exit 1 ;;
esac
[[ "$BACKUP_SHA256" =~ ^[a-f0-9]{64}$ ]] || { echo "backup helper returned an invalid digest" >&2; exit 1; }
[[ "$BACKUP_DATABASE_SHA256" =~ ^[a-f0-9]{64}$ ]] || { echo "backup helper returned an invalid database digest" >&2; exit 1; }
[[ "$BACKUP_SIZE_BYTES" =~ ^[1-9][0-9]*$ ]] || { echo "backup helper returned an invalid byte size" >&2; exit 1; }
[ "$BACKUP_TARGET_VERSION" = "$TARGET_VERSION" ] || { echo "backup helper target version mismatch" >&2; exit 1; }
[[ "$BACKUP_CREATED_AT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || {
  echo "backup helper returned an invalid timestamp" >&2
  exit 1
}

if [ "$MIGRATION_REVIEW_COUNT" -gt 0 ]; then
  # Legitimate writes may have landed after the online rehearsal. With both
  # owners now proved stopped and the exact snapshot archived, rerun the same
  # candidate migration/readiness gate against a fresh clone of the quiescent
  # source. Its source digest must match the archived database digest.
  set +e
  FINAL_MIGRATION_REHEARSAL_OUTPUT="$("${SSH[@]}" "$SERVER" \
    bash "$PROD_RELEASE/scripts/remote-production-shape-migration-rehearsal.sh" \
      "$PROD_RELEASE" "$PROD_BASE" "$CURRENT_RUNTIME" "$REMOTE_PM2" \
      "$PREDECESSOR_SHA" "$RUNTIME_SHA" "$TARGET_VERSION" "$ARTIFACT_DIGEST" \
      "$MIGRATION_REVIEW_SHA256" "$MIGRATION_POLICY_SUBJECT_SHA256" "$PROMOTION_RUN_ID" \
      stopped_final stopped)"
  FINAL_MIGRATION_REHEARSAL_EXIT=$?
  set -e
  if [ "$FINAL_MIGRATION_REHEARSAL_EXIT" -ne 0 ]; then
    echo "final stopped-state migration rehearsal failed" >&2
    exit "$FINAL_MIGRATION_REHEARSAL_EXIT"
  fi
  FINAL_MIGRATION_REHEARSAL_EVIDENCE="$ROOT/.local/release/production/${RUNTIME_SHA}-${ARTIFACT_DIGEST}-${PROMOTION_RUN_ID}.stopped-migration-rehearsal.json"
  printf '%s' "$FINAL_MIGRATION_REHEARSAL_OUTPUT" | node -e '
    const fs=require("fs");const output=process.argv[1];let raw="";
    process.stdin.on("data",(chunk)=>raw+=chunk);process.stdin.on("end",()=>{
      const parsed=JSON.parse(raw);const temporary=`${output}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(temporary,`${JSON.stringify(parsed,null,2)}\n`,{mode:0o600,flag:"wx"});
        fs.linkSync(temporary,output);fs.rmSync(temporary,{force:true});fs.chmodSync(output,0o600);
      } finally { fs.rmSync(temporary,{force:true}); }
    });' "$FINAL_MIGRATION_REHEARSAL_EVIDENCE"
  FINAL_MIGRATION_REHEARSAL_VALIDATION="$(node "$ROOT/scripts/validate-production-shape-migration-rehearsal.mjs" \
    --root "$ROOT" \
    --evidence "$FINAL_MIGRATION_REHEARSAL_EVIDENCE" \
    --predecessor-runtime-sha "$PREDECESSOR_SHA" \
    --target-runtime-sha "$RUNTIME_SHA" \
    --target-version "$TARGET_VERSION" \
    --artifact-digest "$ARTIFACT_DIGEST" \
    --review-evidence-sha256 "$MIGRATION_REVIEW_SHA256" \
    --migration-policy-subject-sha256 "$MIGRATION_POLICY_SUBJECT_SHA256" \
    --promotion-run-id "$PROMOTION_RUN_ID" \
    --phase stopped_final \
    --database-owner-state stopped)"
  read -r FINAL_MIGRATION_REHEARSAL_SHA256 FINAL_MIGRATION_REHEARSAL_CLONE_SHA256 \
    FINAL_MIGRATION_REHEARSAL_MIGRATED_CLONE_SHA256 FINAL_MIGRATION_REHEARSAL_PENDING_SET_SHA256 \
    FINAL_MIGRATION_REHEARSAL_SOURCE_DATABASE_SHA256 \
    < <(printf '%s' "$FINAL_MIGRATION_REHEARSAL_VALIDATION" | node -e '
      let raw="";process.stdin.on("data",(chunk)=>raw+=chunk);process.stdin.on("end",()=>{
        const value=JSON.parse(raw);process.stdout.write([
          value.evidenceSha256,value.cloneSha256,value.migratedCloneSha256,
          value.pendingMigrationSetSha256,value.sourceDatabaseSha256,
        ].join(" ") + "\n");
      });')
  for digest in "$FINAL_MIGRATION_REHEARSAL_SHA256" "$FINAL_MIGRATION_REHEARSAL_CLONE_SHA256" \
      "$FINAL_MIGRATION_REHEARSAL_MIGRATED_CLONE_SHA256" "$FINAL_MIGRATION_REHEARSAL_PENDING_SET_SHA256" \
      "$FINAL_MIGRATION_REHEARSAL_SOURCE_DATABASE_SHA256"; do
    [[ "$digest" =~ ^[a-f0-9]{64}$ ]] || { echo "final migration rehearsal returned an invalid identity" >&2; exit 1; }
  done
  [ "$FINAL_MIGRATION_REHEARSAL_SOURCE_DATABASE_SHA256" = "$BACKUP_DATABASE_SHA256" ] || {
    echo "final rehearsal source does not match the exact stopped-state backup" >&2
    exit 1
  }

  MIGRATION_BACKUP_EVIDENCE="$ROOT/.local/release/production/${RUNTIME_SHA}-${ARTIFACT_DIGEST}-${PROMOTION_RUN_ID}.migration-backup.json"
  install -d -m 700 "$(dirname "$MIGRATION_BACKUP_EVIDENCE")"
  node - "$MIGRATION_BACKUP_EVIDENCE" "$BACKUP_CREATED_AT" "$PREDECESSOR_SHA" "$RUNTIME_SHA" \
    "$TARGET_VERSION" "$MIGRATION_REVIEW_SHA256" "$MIGRATION_POLICY_SUBJECT_SHA256" \
    "$BACKUP_FILE" "$BACKUP_SHA256" "$BACKUP_SIZE_BYTES" "$BACKUP_ARCHIVED_VERSION" \
    "$ARTIFACT_DIGEST" "$PROMOTION_RUN_ID" "$MIGRATION_REHEARSAL_SHA256" \
    "$MIGRATION_REHEARSAL_CLONE_SHA256" "$MIGRATION_REHEARSAL_MIGRATED_CLONE_SHA256" \
    "$MIGRATION_REHEARSAL_PENDING_SET_SHA256" "$MIGRATION_REHEARSAL_SOURCE_DATABASE_SHA256" \
    "$FINAL_MIGRATION_REHEARSAL_SHA256" "$FINAL_MIGRATION_REHEARSAL_CLONE_SHA256" \
    "$FINAL_MIGRATION_REHEARSAL_MIGRATED_CLONE_SHA256" \
    "$FINAL_MIGRATION_REHEARSAL_PENDING_SET_SHA256" \
    "$FINAL_MIGRATION_REHEARSAL_SOURCE_DATABASE_SHA256" "$BACKUP_DATABASE_SHA256" <<'NODE'
const fs = require('fs');
const [
  output, createdAt, predecessorRuntimeSha, targetRuntimeSha, targetVersion,
  reviewEvidenceSha256, migrationPolicySubjectSha256, remotePath, backupSha256,
  sizeBytes, archivedVersion, artifactDigest, promotionRunId,
  migrationRehearsalEvidenceSha256, sourceCloneSha256, migratedCloneSha256,
  pendingMigrationSetSha256, onlineSourceDatabaseSha256,
  finalMigrationRehearsalEvidenceSha256, finalSourceCloneSha256,
  finalMigratedCloneSha256, finalPendingMigrationSetSha256,
  finalSourceDatabaseSha256, backupDatabaseSha256,
] = process.argv.slice(2);
const evidence = {
  schema: 'nexus.exact-migration-backup-evidence.v2',
  status: 'verified',
  createdAt,
  promotionRunId,
  predecessorRuntimeSha,
  targetRuntimeSha,
  targetVersion,
  artifactDigest,
  reviewEvidenceSha256,
  migrationPolicySubjectSha256,
  productionShapeRehearsals: {
    onlinePreStop: {
      evidenceSha256: migrationRehearsalEvidenceSha256,
      sourceCloneSha256,
      migratedCloneSha256,
      pendingMigrationSetSha256,
      sourceDatabaseSha256: onlineSourceDatabaseSha256,
    },
    stoppedFinal: {
      evidenceSha256: finalMigrationRehearsalEvidenceSha256,
      sourceCloneSha256: finalSourceCloneSha256,
      migratedCloneSha256: finalMigratedCloneSha256,
      pendingMigrationSetSha256: finalPendingMigrationSetSha256,
      sourceDatabaseSha256: finalSourceDatabaseSha256,
    },
  },
  backup: {
    remotePath,
    sha256: backupSha256,
    sizeBytes: Number(sizeBytes),
    archivedVersion,
    targetVersion,
    createdAt,
    databaseSha256: backupDatabaseSha256,
  },
  verification: {
    databaseOwnersStopped: true,
    noOpenDatabaseHandles: true,
    walCheckpointTruncated: true,
    sqliteIntegrity: 'ok',
    sqliteForeignKeys: 'ok',
    archiveSha256Verified: true,
  },
};
const temporary = `${output}.${process.pid}.tmp`;
try {
  fs.writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  fs.linkSync(temporary, output);
  fs.rmSync(temporary, { force: true });
} finally {
  fs.rmSync(temporary, { force: true });
}
NODE
  node "$ROOT/scripts/migration-safety-check.mjs" \
    --base "$PREDECESSOR_SHA" \
    --changed-only \
    --approval-mode promotion \
    --review-evidence "$MIGRATION_REVIEW_EVIDENCE" \
    --rehearsal-evidence "$MIGRATION_REHEARSAL_EVIDENCE" \
    --final-rehearsal-evidence "$FINAL_MIGRATION_REHEARSAL_EVIDENCE" \
    --backup-evidence "$MIGRATION_BACKUP_EVIDENCE" \
    --target-version "$TARGET_VERSION" \
    --artifact-digest "$ARTIFACT_DIGEST" \
    --promotion-run-id "$PROMOTION_RUN_ID"
fi

CANDIDATE_MUTATED=true
set +e
CUTOVER_OUTPUT="$("${SSH[@]}" "$SERVER" bash -s -- \
  "$PROD_RELEASE" "$PROD_BASE" "$REMOTE_PM2" "$RUNTIME_SHA" "$TARGET_VERSION" "$PUBLIC_BASE_URL" \
  "${NEXUS_RELEASE_PRODUCTION_STABILITY_SECONDS:-60}" <<'REMOTE_CUTOVER'
set -euo pipefail
release_dir="$1"; base_dir="$2"; pm2_bin="$3"; runtime_sha="$4"; target_version="$5"; public_base_url="$6"; stability_seconds="$7"
echo "legacy production cutover is retired; use the root-owned selector transaction" >&2
exit 77
for app in nexus-hub content-engine; do
  if "$pm2_bin" describe "$app" >/dev/null 2>&1; then "$pm2_bin" delete "$app" >/dev/null; fi
done
env -i HOME="$HOME" PATH="$PATH" NEXUS_RELEASE_DIR="$release_dir" NEXUS_RELEASE_BASE_DIR="$base_dir" \
  NEXUS_RELEASE_ROLE=production NEXUS_RELEASE_SHA="$runtime_sha" \
  "$pm2_bin" start "$release_dir/ecosystem.release.config.js" --update-env

# This is the authoritative post-start gate: native addon load, live SQLite
# integrity, authenticated Content Engine /ready, exact PM2 identity, and two
# restart-stability samples. The outer recovery trap remains armed throughout.
bash "$release_dir/scripts/remote-release-readiness.sh" \
  --role production --base-dir "$base_dir" --release-dir "$release_dir" \
  --runtime-sha "$runtime_sha" --pm2-bin "$pm2_bin" --node-bin /usr/bin/node \
  --output "$release_dir/.nexus-release-readiness-production.json" \
  --stability-seconds "$stability_seconds"

auth_header="$(mktemp)"; local_health="$(mktemp)"; public_health="$(mktemp)"; public_snapshot="$(mktemp)"
cleanup_probe_files() { rm -f "$auth_header" "$local_health" "$public_health" "$public_snapshot"; }
trap cleanup_probe_files EXIT
chmod 600 "$auth_header" "$local_health" "$public_health" "$public_snapshot"
require_session="$(awk -F= '$1=="PORTAL_REQUIRE_SESSION_AUTH" {print substr($0,index($0,"=")+1); exit}' "$base_dir/.env" 2>/dev/null || true)"
if [ "$require_session" = true ]; then
  portal_token="$(cd "$release_dir" && DOTENV_CONFIG_PATH="$base_dir/.env" node -r dotenv/config \
    dist/tools/portal-session-token.js --actor release-promotion@nexushub.me --scope admin --ttl-ms 300000 --json \
    | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(b).token||""))')"
  [ -n "$portal_token" ] || { echo "production session token generation failed" >&2; exit 1; }
  printf 'x-portal-session: %s\n' "$portal_token" > "$auth_header"
else
  portal_token="$(awk -F= '$1=="PORTAL_TOKEN" {print substr($0,index($0,"=")+1); exit}' "$base_dir/.env" 2>/dev/null || true)"
  [ -n "$portal_token" ] || { echo "production portal auth credential is missing" >&2; exit 1; }
  printf 'Authorization: Bearer %s\n' "$portal_token" > "$auth_header"
fi

backend_ok=false; content_ok=false; identity_ok=false; public_health_ok=false; public_snapshot_ok=false
for _ in $(seq 1 15); do
  backend_ok=false; content_ok=false; identity_ok=false; public_health_ok=false; public_snapshot_ok=false
  if curl --fail --silent --show-error --connect-timeout 1 --max-time 5 \
      http://127.0.0.1:8200/health > "$local_health" \
      && node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(x.status!=="healthy"||x.server?.status!=="online"||x.database!=="connected")process.exit(1)' "$local_health"; then
    backend_ok=true
  fi
  if curl --fail --silent --show-error --connect-timeout 1 --max-time 5 \
      http://127.0.0.1:8100/health >/dev/null; then
    content_ok=true
  fi
  if [ "$(readlink -f "$base_dir/current")" = "$release_dir" ] \
      && "$pm2_bin" jlist | node -e '
        const fs=require("fs");const rows=JSON.parse(fs.readFileSync(0,"utf8"));
        const root=process.argv[1],sha=process.argv[2];
        for(const [name,cwd] of [["nexus-hub",root],["content-engine",`${root}/content-engine`]]){
          const row=rows.find((entry)=>entry?.name===name),env=row?.pm2_env??{};
          if(env.status!=="online"||env.pm_cwd!==cwd||(env.NEXUS_RELEASE_SHA||env.GIT_COMMIT)!==sha)process.exit(1);
        }' "$release_dir" "$runtime_sha"; then
    identity_ok=true
  fi
  if curl --fail --silent --show-error --connect-timeout 2 --max-time 10 \
      "$public_base_url/health" > "$public_health" \
      && node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(x.status!=="healthy"||x.server?.status!=="online"||x.database!=="connected")process.exit(1)' "$public_health"; then
    public_health_ok=true
  fi
  if curl --fail --silent --show-error --connect-timeout 2 --max-time 15 -H @"$auth_header" \
      "$public_base_url/api/snapshot" > "$public_snapshot"; then
    if node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(x.version!==process.argv[2])process.exit(1)' \
        "$public_snapshot" "$target_version"; then
      public_snapshot_ok=true
    fi
  fi
  if [ "$backend_ok" = true ] && [ "$content_ok" = true ] && [ "$identity_ok" = true ] \
      && [ "$public_health_ok" = true ] && [ "$public_snapshot_ok" = true ]; then
    "$pm2_bin" save >/dev/null
    printf 'NEXUS_PRODUCTION_VERIFICATION={"nativeBinding":true,"sqliteIntegrity":true,"sqliteForeignKeys":true,"loopbackBackend":true,"authenticatedContentEngine":true,"pm2AndCurrentIdentity":true,"pm2RestartStable":true,"publicHealth":true,"publicSnapshotVersion":true}\n'
    exit 0
  fi
  sleep 2
done
echo "candidate readiness failed: backend=$backend_ok content=$content_ok identity=$identity_ok publicHealth=$public_health_ok publicSnapshot=$public_snapshot_ok" >&2
exit 1
REMOTE_CUTOVER
)"
CUTOVER_EXIT=$?
set -e
printf '%s\n' "$CUTOVER_OUTPUT"
if [ "$CUTOVER_EXIT" -ne 0 ]; then
  echo "candidate failed exact loopback/public readiness" >&2
  exit "$CUTOVER_EXIT"
fi
RECOVERY_COMPLETE=true

CUTOVER_SECONDS="$(( $(date +%s) - CUTOVER_STARTED_EPOCH ))"
EVIDENCE="$ROOT/.local/release/production/${RUNTIME_SHA}-${ARTIFACT_DIGEST}.json"
mkdir -p "$(dirname "$EVIDENCE")"
node - "$EVIDENCE" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$BACKUP_FILE" "$PROMOTION_STARTED_AT" "$CUTOVER_SECONDS" "$TARGET_VERSION" "$PUBLIC_BASE_URL" <<'NODE'
const fs = require('fs');
const [file, runtimeSha, artifactDigest, backupFile, startedAt, cutoverSeconds, packageVersion, publicBaseUrl] = process.argv.slice(2);
fs.writeFileSync(file, `${JSON.stringify({
  schema: 'nexus.production-promotion-evidence.v1', status: 'passed', runtimeSha,
  artifactDigest, exactBackup: backupFile, startedAt, completedAt: new Date().toISOString(),
  cutoverSeconds: Number(cutoverSeconds),
  packageVersion,
  verification: {
    nativeBinding: true,
    sqliteIntegrity: true,
    sqliteForeignKeys: true,
    loopbackBackend: true,
    authenticatedContentEngine: true,
    pm2AndCurrentIdentity: true,
    pm2RestartStable: true,
    publicHealth: { baseUrl: publicBaseUrl, status: 'healthy', database: 'connected' },
    publicSnapshotVersion: packageVersion,
  },
}, null, 2)}\n`, { mode: 0o600 });
NODE
printf '{"ok":true,"runtimeSha":"%s","artifactDigest":"%s","cutoverSeconds":%s,"exactBackup":"%s"}\n' \
  "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$CUTOVER_SECONDS" "$BACKUP_FILE"
