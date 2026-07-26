#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/lib/release-gates.sh"
COMMAND="${1:-status}"
[ $# -gt 0 ] && shift
usage() {
  echo "Usage: scripts/release-operator.sh <prepare|staging|drill-staging|promote|status|resume> [--base <sha>] [--manifest <file>] [--staging-attestation <file>] [--dry-run] [--no-sign-request] [--request-id <uuid>] [--coordinator-checkpoint <file>] [--acknowledge-first-drill-bootstrap]"
  echo "       prepare requires exactly one contract scope: --backend-only OR --includes-ios --ios-sha <sha> --ios-build-number <number> --ios-contract-result passed"
  echo "       drill-staging uses the installed control-v2 legacy-base broker and always remains non-promotable"
  echo "       resume coordinates RC -> signing -> staging -> explicit owner stop -> promotion with a local checkpoint"
}
if [ "$COMMAND" = "-h" ] || [ "$COMMAND" = "--help" ]; then usage; exit 0; fi
if [ "$COMMAND" = "resume" ]; then
  exec node "$ROOT/scripts/release-sequence.mjs" "$@"
fi
BASE="origin/main"
MANIFEST=""
STAGING_ATTESTATION=""
DRY_RUN=false
SIGN_REQUEST="${NEXUS_RELEASE_SIGN_STAGING:-1}"
CONTRACT_SCOPE=""
IOS_SHA=""
IOS_BUILD_NUMBER=""
IOS_CONTRACT_RESULT=""
STAGING_REQUEST_ID=""
COORDINATOR_CHECKPOINT=""
ACKNOWLEDGE_FIRST_DRILL_BOOTSTRAP=false
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --manifest) MANIFEST="$2"; shift 2 ;;
    --staging-attestation) STAGING_ATTESTATION="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --no-sign-request) SIGN_REQUEST=0; shift ;;
    --request-id) STAGING_REQUEST_ID="$2"; shift 2 ;;
    --coordinator-checkpoint) COORDINATOR_CHECKPOINT="$2"; shift 2 ;;
    --acknowledge-first-drill-bootstrap)
      ACKNOWLEDGE_FIRST_DRILL_BOOTSTRAP=true
      shift
      ;;
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
    --ios-sha) IOS_SHA="$2"; shift 2 ;;
    --ios-build-number) IOS_BUILD_NUMBER="$2"; shift 2 ;;
    --ios-contract-result) IOS_CONTRACT_RESULT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 64 ;;
  esac
done

if [ "$COMMAND" != "prepare" ] && [ -n "$CONTRACT_SCOPE$IOS_SHA$IOS_BUILD_NUMBER$IOS_CONTRACT_RESULT" ]; then
  echo "release contract scope arguments are valid only for release:prepare" >&2
  exit 64
fi
if [ "$COMMAND" != "staging" ] && [ "$COMMAND" != "drill-staging" ] \
    && [ -n "$STAGING_REQUEST_ID$COORDINATOR_CHECKPOINT" ]; then
  echo "staging request identity arguments are valid only for release:staging or release:drill-staging" >&2
  exit 64
fi
if [ "$COMMAND" != "drill-staging" ] && [ "$ACKNOWLEDGE_FIRST_DRILL_BOOTSTRAP" = true ]; then
  echo "--acknowledge-first-drill-bootstrap is valid only for release:drill-staging" >&2
  exit 64
fi
[ -z "$STAGING_REQUEST_ID" ] \
  || [[ "$STAGING_REQUEST_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
  || { echo "staging request id is invalid" >&2; exit 64; }
[ -z "$COORDINATOR_CHECKPOINT" ] || [ -n "$STAGING_REQUEST_ID" ] || {
  echo "a coordinator checkpoint requires an exact staging request id" >&2
  exit 64
}

SHA="$(git rev-parse HEAD)"
MANIFEST="${MANIFEST:-.local/release/manifests/$SHA.json}"

absolute_path() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$ROOT" "$1" ;;
  esac
}

manifest_field() {
  node -e 'const e=require(process.argv[1]); const keys=process.argv[2].split("."); let v=e; for(const k of keys)v=v?.[k]; if(v==null)process.exit(2); process.stdout.write(String(v));' "$(absolute_path "$MANIFEST")" "$1"
}

resolve_manifest_bundle() {
  RUNTIME_SHA="$(manifest_field payload.runtimeSha)" || {
    echo "release manifest runtime SHA is missing" >&2
    return 1
  }
  DIGEST="$(manifest_field payload.artifact.digest)" || {
    echo "release manifest artifact digest is missing" >&2
    return 1
  }
  [[ "$RUNTIME_SHA" =~ ^[0-9a-f]{40}$ ]] || {
    echo "release manifest runtime SHA is invalid" >&2
    return 1
  }
  [[ "$DIGEST" =~ ^[0-9a-f]{64}$ ]] || {
    echo "release manifest artifact digest is invalid" >&2
    return 1
  }
  [ "$RUNTIME_SHA" = "$SHA" ] || {
    echo "release manifest is not bound to the checked-out runtime SHA" >&2
    return 1
  }
  BUNDLE="$ROOT/.local/release/bundles/$RUNTIME_SHA/$DIGEST"
  [ -f "$BUNDLE/.complete.json" ] || {
    echo "immutable bundle missing: $BUNDLE" >&2
    return 1
  }
}

validate_manifest() {
  resolve_manifest_bundle
  node scripts/release-manifest-v2.mjs validate \
    --manifest "$(absolute_path "$MANIFEST")" \
    --root "$BUNDLE" \
    --verify-bundle \
    --public-key "$ROOT/docs/release/evidence/release-evidence-public-key.pem" \
    --expect-runtime-sha "$RUNTIME_SHA"
}

validate_staging_coordinator_checkpoint() {
  [ -n "$COORDINATOR_CHECKPOINT" ] || return 1
  node - "$(absolute_path "$COORDINATOR_CHECKPOINT")" "$ROOT" \
    "$STAGING_REQUEST_ID" "$RUNTIME_SHA" "$DIGEST" "$(absolute_path "$MANIFEST")" <<'NODE'
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const [checkpoint,root,requestId,runtimeSha,artifactDigest,manifest]=process.argv.slice(2);
const expectedRoot=path.join(path.resolve(root),'.local','release','checkpoints');
const resolved=path.resolve(checkpoint);
if(path.dirname(resolved)!==expectedRoot)throw new Error('coordinator checkpoint is outside the canonical directory');
const rootStat=fs.lstatSync(expectedRoot);
if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||rootStat.uid!==process.getuid()
  ||(rootStat.mode&0o077)!==0){
  throw new Error('coordinator checkpoint directory is unsafe');
}
const before=fs.lstatSync(resolved);
if(!before.isFile()||before.isSymbolicLink()||before.uid!==process.getuid()
  ||(before.mode&0o777)!==0o600||before.nlink!==1||before.size<=0||before.size>2*1024*1024){
  throw new Error('coordinator checkpoint is not a private owner regular file');
}
const fd=fs.openSync(resolved,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
let body;
try{
  const opened=fs.fstatSync(fd);
  if(opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size){
    throw new Error('coordinator checkpoint changed while it was opened');
  }
  body=fs.readFileSync(fd);
  const after=fs.fstatSync(fd);
  if(after.dev!==opened.dev||after.ino!==opened.ino||after.size!==body.length){
    throw new Error('coordinator checkpoint changed while it was read');
  }
}finally{
  fs.closeSync(fd);
}
const state=JSON.parse(body.toString('utf8'));
const manifestSha=crypto.createHash('sha256').update(fs.readFileSync(manifest)).digest('hex');
if(state.schema!=='nexus.release-sequence-checkpoint.v1'||state.runtimeSha!==runtimeSha
  ||state.artifactDigest!==artifactDigest||state.signedManifestSha256!==manifestSha
  ||state.stagingAttempt?.schema!=='nexus.staging-attempt.v1'
  ||state.stagingAttempt?.requestId!==requestId
  ||state.stagingAttempt?.runtimeSha!==runtimeSha
  ||state.stagingAttempt?.artifactDigest!==artifactDigest
  ||state.stagingAttempt?.releaseManifestSha256!==manifestSha
  ||!['intent_persisted','deploy_started','request_ready'].includes(state.stagingAttempt?.status)){
  throw new Error('coordinator checkpoint does not bind the exact staging attempt');
}
NODE
}

resolve_staging_attestation() {
  local runtime_sha="$1" digest="$2"
  STAGING_ATTESTATION="${STAGING_ATTESTATION:-.local/release/staging/${runtime_sha}-${digest}.signed.json}"
}

validate_staging_attestation() {
  local runtime_sha="$1" digest="$2"
  resolve_staging_attestation "$runtime_sha" "$digest"
  node scripts/release-staging-attestation.mjs validate \
    --attestation "$STAGING_ATTESTATION" \
    --manifest "$MANIFEST" \
    --expect-runtime-sha "$runtime_sha"
}

validate_rollback_drill_freshness() {
  node scripts/rollback-drill-check.mjs validate \
    --root "$ROOT" \
    --release-gate \
    --max-age-days 30 \
    --json >/dev/null
}

resolve_remote_pm2() {
  local server="$1"
  ssh "$server" 'for p in "$(command -v pm2 2>/dev/null || true)" /usr/local/bin/pm2 "$HOME/.npm-global/bin/pm2"; do if [ -n "$p" ] && [ -x "$p" ]; then printf "%s" "$p"; exit 0; fi; done; exit 1'
}

case "$COMMAND" in
  drill-staging)
    [ "$ACKNOWLEDGE_FIRST_DRILL_BOOTSTRAP" = true ] || {
      echo "release:drill-staging requires --acknowledge-first-drill-bootstrap" >&2
      exit 64
    }
    SERVER="${DEPLOY_SERVER:-dominguez@serverdominguez}"
    BASE_DIR=/home/dominguez/telegram-hub-bot-staging
    BROKER="${NEXUS_LEGACY_DRILL_BROKER:-/usr/local/sbin/nexus-rollback-drill-legacy-staging-broker}"
    [ "${STAGING_PATH:-$BASE_DIR}" = "$BASE_DIR" ] || {
      echo "release:drill-staging accepts only the governed legacy staging base" >&2
      exit 64
    }
    [ "$BROKER" = /usr/local/sbin/nexus-rollback-drill-legacy-staging-broker ] || {
      echo "release:drill-staging accepts only the root-installed broker path" >&2
      exit 64
    }
    if [ "$DRY_RUN" = true ]; then
      printf '{"ok":true,"dryRun":true,"promotable":false,"rollbackDrillEligible":false,"featureEnabled":true,"reason":"execution_and_protected_drill_signature_required","server":"%s","base":"%s","broker":"%s"}\n' \
        "$SERVER" "$BASE_DIR" "$BROKER"
      exit 0
    fi
    if ! release_require_clean_tree "$ROOT"; then
      echo "release:drill-staging requires a clean checkout bound to the signed runtime SHA" >&2
      exit 1
    fi
    validate_manifest
    if [ -n "$STAGING_REQUEST_ID" ]; then
      validate_staging_coordinator_checkpoint || {
        echo "drill-staging coordinator checkpoint validation failed" >&2
        exit 1
      }
    else
      STAGING_REQUEST_ID="$(node -e 'process.stdout.write(require("crypto").randomUUID())')"
    fi
    RELEASE_DIR="$BASE_DIR/releases/${RUNTIME_SHA}-${DIGEST:0:12}"
    EVIDENCE_DIR="$ROOT/.local/release/rollback-drill-staging"
    EVIDENCE_BASE="$EVIDENCE_DIR/${RUNTIME_SHA}-${DIGEST}-${STAGING_REQUEST_ID}"
    INSPECTION="$EVIDENCE_BASE.broker-inspection.json"
    TRANSACTION_REQUEST="$EVIDENCE_BASE.transaction-request.json"
    ROOT_EVIDENCE="$EVIDENCE_BASE.root-evidence.json"
    STAGING_REQUEST="$EVIDENCE_BASE.request.json"
    SIGNED_BUNDLE="$EVIDENCE_BASE.bundle"
    DRILL_CHECKPOINT="$EVIDENCE_BASE.checkpoint.json"
    install -d -m 700 "$ROOT/.local" "$ROOT/.local/release" "$EVIDENCE_DIR"
    DRILL_CHECKPOINT_STATUS="$(
      node scripts/rollback-drill-legacy-staging-adapter.mjs \
        ensure-operator-checkpoint \
        --output "$DRILL_CHECKPOINT" \
        --manifest "$(absolute_path "$MANIFEST")" \
        --request-id "$STAGING_REQUEST_ID" \
        --runtime-sha "$RUNTIME_SHA" \
        --artifact-digest "$DIGEST" \
        --release-dir "$RELEASE_DIR" \
        --server "$SERVER" \
        --base "$BASE_DIR" \
        --broker "$BROKER" \
        --evidence-base "$EVIDENCE_BASE"
    )"
    DRILL_CHECKPOINT_RESUMED="$(
      node -e '
const x=JSON.parse(process.argv[1]);
if(x.ok!==true||x.promotable!==false||typeof x.resumed!=="boolean")process.exit(1);
process.stdout.write(String(x.resumed));' "$DRILL_CHECKPOINT_STATUS"
    )" || {
      echo "legacy staging checkpoint status is invalid" >&2
      exit 1
    }

    DRILL_TEMPORARY=
    cleanup_drill_temporary() {
      if [ -n "$DRILL_TEMPORARY" ]; then
        case "$DRILL_TEMPORARY" in
          "$EVIDENCE_DIR"/.*."$STAGING_REQUEST_ID".*)
            rm -f -- "$DRILL_TEMPORARY"
            ;;
        esac
      fi
    }
    cleanup_drill_staging_state() {
      cleanup_drill_temporary
      release_cleanup_all_locks
    }
    validate_private_drill_file() {
      node - "$1" "$EVIDENCE_DIR" "$2" <<'NODE'
const fs=require('node:fs');const path=require('node:path');
const [file,evidenceDir,label]=process.argv.slice(2);
const resolved=path.resolve(file),expectedParent=path.resolve(evidenceDir);
if(path.dirname(resolved)!==expectedParent)throw new Error(`${label} path is outside the evidence directory`);
const parent=fs.lstatSync(expectedParent);
if(!parent.isDirectory()||parent.isSymbolicLink()
 ||fs.realpathSync.native(expectedParent)!==expectedParent
 ||parent.uid!==process.getuid()||(parent.mode&0o7777)!==0o700){
 throw new Error(`${label} evidence directory is unsafe`);
}
const before=fs.lstatSync(resolved);
if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1
 ||before.uid!==process.getuid()||(before.mode&0o7777)!==0o600
 ||before.size<=0||before.size>32*1024*1024){
 throw new Error(`${label} is not a private bounded owner file`);
}
const descriptor=fs.openSync(resolved,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
try{
 const opened=fs.fstatSync(descriptor);
 if(opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size
  ||opened.mtimeMs!==before.mtimeMs)throw new Error(`${label} changed while opened`);
 const body=fs.readFileSync(descriptor);
 const after=fs.fstatSync(descriptor);
 if(after.dev!==opened.dev||after.ino!==opened.ino||after.size!==body.length
  ||after.mtimeMs!==opened.mtimeMs)throw new Error(`${label} changed while read`);
}finally{fs.closeSync(descriptor);}
NODE
    }
    publish_fetched_drill_file() {
      local temporary="$1" destination="$2" label="$3"
      validate_private_drill_file "$temporary" "$label"
      if [ -e "$destination" ] || [ -L "$destination" ]; then
        validate_private_drill_file "$destination" "$label"
        cmp -s -- "$temporary" "$destination" || {
          echo "$label differs from the exact request-scoped checkpoint" >&2
          return 1
        }
        rm -f -- "$temporary"
      else
        mv -- "$temporary" "$destination"
        node -e '
const fs=require("node:fs");const path=require("node:path");
const descriptor=fs.openSync(path.dirname(process.argv[1]),"r");
try{fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}' "$destination"
      fi
      DRILL_TEMPORARY=
    }
    parse_drill_status() {
      node - "$1" "$STAGING_REQUEST_ID" "$RUNTIME_SHA" "$DIGEST" <<'NODE'
const [raw,id,runtimeSha,artifactDigest]=process.argv.slice(2);
const x=JSON.parse(raw);
const keys=['artifactDigest','ok','phase','promotable','recoveryTargetMet',
 'requestId','runtimeSha','successful','terminal'];
if(!x||typeof x!=='object'||Array.isArray(x)
 ||Object.keys(x).sort().join(',')!==keys.sort().join(',')
 ||x.ok!==true||x.promotable!==false||x.requestId!==id
 ||x.runtimeSha!==runtimeSha||x.artifactDigest!==artifactDigest
 ||typeof x.phase!=='string'||typeof x.terminal!=='boolean'
 ||typeof x.successful!=='boolean'
 ||!(x.recoveryTargetMet===null||typeof x.recoveryTargetMet==='boolean')){
 process.exit(1);
}
process.stdout.write(`${x.phase}\t${x.terminal}\t${x.successful}`);
NODE
    }

    trap cleanup_drill_staging_state EXIT
    release_acquire_local_lock "$ROOT" "rollback-drill-staging"
    REMOTE_TRANSACTION=false
    TERMINAL=false
    SUCCESSFUL=false
    TRANSACTION_PHASE=missing
    set +e
    INITIAL_STATUS_JSON="$(
      ssh "$SERVER" sudo -n "$BROKER" status "$STAGING_REQUEST_ID"
    )"
    INITIAL_STATUS_CODE=$?
    set -e
    case "$INITIAL_STATUS_CODE" in
      0)
        STATUS_FIELDS="$(parse_drill_status "$INITIAL_STATUS_JSON")" || {
          echo "root broker returned invalid exact-identity transaction status" >&2
          exit 1
        }
        IFS=$'\t' read -r TRANSACTION_PHASE TERMINAL SUCCESSFUL \
          <<<"$STATUS_FIELDS"
        REMOTE_TRANSACTION=true
        ;;
      66) ;;
      255)
        echo "root broker status is unreachable; exact request checkpoint retained" >&2
        exit 75
        ;;
      *)
        echo "root broker transaction status failed closed" >&2
        exit "$INITIAL_STATUS_CODE"
        ;;
    esac
    if [ "$REMOTE_TRANSACTION" = true ]; then
      [ "$DRILL_CHECKPOINT_RESUMED" = true ] || {
        echo "remote transaction predates the durable local request checkpoint" >&2
        exit 75
      }
      validate_private_drill_file \
        "$TRANSACTION_REQUEST" "legacy staging transaction request" || {
          echo "remote transaction exists without its local exact request state" >&2
          exit 75
        }
      node scripts/rollback-drill-legacy-staging-adapter.mjs \
        validate-transaction-request \
        --request "$TRANSACTION_REQUEST" \
        --public-key "$ROOT/docs/release/evidence/release-evidence-public-key.pem" \
        --expect-request-id "$STAGING_REQUEST_ID" \
        --allow-expired-resume true >/dev/null
    fi

    if [ "$REMOTE_TRANSACTION" = false ]; then
      DRILL_TEMPORARY="$(
        mktemp "$EVIDENCE_DIR/.broker-inspection.$STAGING_REQUEST_ID.XXXXXXXX"
      )"
      ssh "$SERVER" sudo -n "$BROKER" inspect >"$DRILL_TEMPORARY"
      chmod 600 "$DRILL_TEMPORARY"
      INSPECTION_STATUS="$(
        node scripts/rollback-drill-legacy-staging-adapter.mjs \
          validate-inspection --inspection "$DRILL_TEMPORARY"
      )"
      BROKER_FIELDS="$(
        node -e '
const x=JSON.parse(process.argv[1]);
if(x.ok!==true||x.promotable!==false
 ||!/^[a-f0-9]{64}$/.test(x.broker?.sha256??"")
 ||!/^[a-f0-9]{64}$/.test(x.broker?.adapterSha256??""))process.exit(1);
process.stdout.write(`${x.broker.sha256}\t${x.broker.adapterSha256}`);' \
          "$INSPECTION_STATUS"
      )" || {
        echo "validated broker inspection omitted its exact executable identity" >&2
        exit 1
      }
      IFS=$'\t' read -r BROKER_SHA256 ADAPTER_SHA256 <<<"$BROKER_FIELDS"
      publish_fetched_drill_file \
        "$DRILL_TEMPORARY" "$INSPECTION" "legacy staging broker inspection"
    PREPARED="$(
      ssh "$SERVER" sudo -n "$BROKER" prepare \
        "$STAGING_REQUEST_ID" "$RUNTIME_SHA" "$DIGEST"
    )"
    PREPARED_FIELDS="$(
      node - "$PREPARED" "$STAGING_REQUEST_ID" "$RELEASE_DIR" "$BASE_DIR" <<'NODE'
const path=require('node:path');
const [raw,requestId,releaseDir,base]=process.argv.slice(2);
const x=JSON.parse(raw);
const expectedUpload=`${base}/.local/release/legacy-staging-drill/${requestId}/request.json`;
const keys=['ok','promotable','releaseDir','requestId','requestUpload'];
if(!x||typeof x!=='object'||Array.isArray(x)
 ||Object.keys(x).sort().join(',')!==keys.sort().join(',')
 ||x.ok!==true||x.promotable!==false||x.requestId!==requestId
 ||x.releaseDir!==releaseDir||x.requestUpload!==expectedUpload
 ||path.posix.normalize(x.releaseDir)!==x.releaseDir
 ||path.posix.normalize(x.requestUpload)!==x.requestUpload)process.exit(1);
process.stdout.write(`${x.releaseDir}\t${x.requestUpload}`);
NODE
    )" || {
      echo "root broker returned an invalid preparation binding" >&2
      exit 1
    }
    IFS=$'\t' read -r PREPARED_RELEASE_DIR REQUEST_UPLOAD \
      <<<"$PREPARED_FIELDS"
    [ "$PREPARED_RELEASE_DIR" = "$RELEASE_DIR" ] || {
      echo "root broker release directory differs from the signed artifact" >&2
      exit 1
    }
    rsync -az --delete --chmod=D700,Fu+rw,go-rwx \
      "$BUNDLE/" "$SERVER:$RELEASE_DIR/"
    if [ -e "$TRANSACTION_REQUEST" ] || [ -L "$TRANSACTION_REQUEST" ]; then
      validate_private_drill_file \
        "$TRANSACTION_REQUEST" "legacy staging transaction request"
      node scripts/rollback-drill-legacy-staging-adapter.mjs \
        validate-transaction-request \
        --request "$TRANSACTION_REQUEST" \
        --public-key "$ROOT/docs/release/evidence/release-evidence-public-key.pem" \
        --expect-request-id "$STAGING_REQUEST_ID" \
        --expect-broker-sha256 "$BROKER_SHA256" \
        --expect-adapter-sha256 "$ADAPTER_SHA256" >/dev/null
    else
      node scripts/rollback-drill-legacy-staging-adapter.mjs \
        build-transaction-request \
        --manifest "$(absolute_path "$MANIFEST")" \
        --inspection "$INSPECTION" \
        --request-id "$STAGING_REQUEST_ID" \
        --public-key "$ROOT/docs/release/evidence/release-evidence-public-key.pem" \
        --output "$TRANSACTION_REQUEST" >/dev/null
    fi
    scp -q "$TRANSACTION_REQUEST" "$SERVER:$REQUEST_UPLOAD"
    ssh "$SERVER" chmod 600 -- "$REQUEST_UPLOAD"
    SUBMITTED="$(
      ssh "$SERVER" sudo -n "$BROKER" launch "$STAGING_REQUEST_ID"
    )"
    node -e '
const x=JSON.parse(process.argv[1]),id=process.argv[2];
if(x.ok!==true||x.promotable!==false||x.requestId!==id
 ||x.status!=="submitted")process.exit(1);' \
      "$SUBMITTED" "$STAGING_REQUEST_ID" || {
      echo "root broker did not durably accept the transaction" >&2
      exit 1
    }
    fi

    for _ in $(seq 1 900); do
      [ "$TERMINAL" = false ] || break
      set +e
      STATUS_JSON="$(
        ssh "$SERVER" sudo -n "$BROKER" status "$STAGING_REQUEST_ID"
      )"
      STATUS_CODE=$?
      set -e
      if [ "$STATUS_CODE" -eq 255 ]; then
        sleep 2
        continue
      fi
      [ "$STATUS_CODE" -eq 0 ] || {
        echo "root broker transaction status failed closed" >&2
        exit "$STATUS_CODE"
      }
      STATUS_FIELDS="$(parse_drill_status "$STATUS_JSON")" || {
        echo "root broker returned invalid exact-identity transaction status" >&2
        exit 1
      }
      IFS=$'\t' read -r TRANSACTION_PHASE TERMINAL SUCCESSFUL \
        <<<"$STATUS_FIELDS"
      [ "$TERMINAL" = true ] || sleep 2
    done
    [ "$TERMINAL" = true ] || {
      echo "legacy staging drill did not reach a terminal state within 30 minutes" >&2
      exit 75
    }
    [ "$SUCCESSFUL" = true ] && [ "$TRANSACTION_PHASE" = completed ] || {
      echo "legacy staging drill recovered its predecessor; no staging evidence is eligible" >&2
      exit 75
    }
    DRILL_TEMPORARY="$(
      mktemp "$EVIDENCE_DIR/.root-evidence.$STAGING_REQUEST_ID.XXXXXXXX"
    )"
    ssh "$SERVER" sudo -n "$BROKER" fetch-evidence \
      "$STAGING_REQUEST_ID" >"$DRILL_TEMPORARY"
    chmod 600 "$DRILL_TEMPORARY"
    ROOT_EVIDENCE_STATUS="$(
      node scripts/rollback-drill-legacy-staging-adapter.mjs \
        validate-broker-evidence --evidence "$DRILL_TEMPORARY"
    )"
    node -e '
const x=JSON.parse(process.argv[1]);
if(x.ok!==true||x.promotable!==false||x.requestId!==process.argv[2]
 ||x.runtimeSha!==process.argv[3]||x.artifactDigest!==process.argv[4]){
 process.exit(1);
}' "$ROOT_EVIDENCE_STATUS" "$STAGING_REQUEST_ID" "$RUNTIME_SHA" "$DIGEST" || {
      echo "terminal broker evidence differs from the exact request checkpoint" >&2
      exit 1
    }
    publish_fetched_drill_file \
      "$DRILL_TEMPORARY" "$ROOT_EVIDENCE" "legacy staging root evidence"
    if [ -e "$STAGING_REQUEST" ] || [ -L "$STAGING_REQUEST" ]; then
      validate_private_drill_file \
        "$STAGING_REQUEST" "legacy staging attestation request"
      node scripts/rollback-drill-legacy-staging-adapter.mjs \
        validate-staging-request \
        --request "$STAGING_REQUEST" \
        --manifest "$(absolute_path "$MANIFEST")" \
        --evidence "$ROOT_EVIDENCE" \
        --public-key "$ROOT/docs/release/evidence/release-evidence-public-key.pem" \
        --expect-runtime-sha "$RUNTIME_SHA" >/dev/null
    else
      node scripts/rollback-drill-legacy-staging-adapter.mjs \
        build-staging-request \
        --manifest "$(absolute_path "$MANIFEST")" \
        --evidence "$ROOT_EVIDENCE" \
        --public-key "$ROOT/docs/release/evidence/release-evidence-public-key.pem" \
        --output "$STAGING_REQUEST" >/dev/null
    fi
    MANIFEST_SIGNING_RECEIPT="$ROOT/.local/release/signing-provenance/$RUNTIME_SHA.json"
    MANIFEST_SIGNING_RECEIPT_STATUS="$(
      node scripts/release-signing-provenance-receipt.mjs verify \
        --receipt "$MANIFEST_SIGNING_RECEIPT" \
        --manifest "$(absolute_path "$MANIFEST")" \
        --expect-runtime-sha "$RUNTIME_SHA"
    )" || {
      echo "exact SHA-scoped manifest-signing provenance receipt is invalid" >&2
      exit 1
    }
    MANIFEST_SIGNING_RUN_ID="$(
      node -e '
const result=JSON.parse(process.argv[1]);
if(result.ok!==true||result.runtimeSha!==process.argv[2]
    ||!/^[1-9][0-9]*$/.test(result.signingRunId??"")
    ||!/^[1-9][0-9]*$/.test(result.signingRunAttempt??"")){
  process.exit(1);
}
process.stdout.write(result.signingRunId);' \
        "$MANIFEST_SIGNING_RECEIPT_STATUS" "$RUNTIME_SHA"
    )" || {
      echo "manifest-signing provenance receipt status is invalid" >&2
      exit 1
    }
    [[ "$MANIFEST_SIGNING_RUN_ID" =~ ^[1-9][0-9]*$ ]] || {
      echo "manifest-signing provenance receipt does not bind an exact protected run" >&2
      exit 1
    }
    command -v gh >/dev/null 2>&1 \
      || { echo "GitHub CLI is required to revalidate manifest-signing provenance" >&2; exit 1; }
    gh auth status >/dev/null 2>&1 \
      || { echo "GitHub CLI authentication is required to revalidate manifest-signing provenance" >&2; exit 1; }
    SIGNING_METADATA_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/nexus-signing-provenance.XXXXXXXX")"
    cleanup_signing_metadata() {
      case "$SIGNING_METADATA_DIRECTORY" in
        "${TMPDIR:-/tmp}"/nexus-signing-provenance.*)
          rm -rf "$SIGNING_METADATA_DIRECTORY"
          ;;
      esac
    }
    cleanup_drill_staging_exit() {
      cleanup_signing_metadata
      release_cleanup_all_locks
    }
    trap cleanup_drill_staging_exit EXIT
    gh api \
      "repos/felipedrf74/cortex-telegram-hub-bot/actions/runs/$MANIFEST_SIGNING_RUN_ID" \
      >"$SIGNING_METADATA_DIRECTORY/run.json"
    gh api \
      "repos/felipedrf74/cortex-telegram-hub-bot/actions/runs/$MANIFEST_SIGNING_RUN_ID/artifacts?per_page=100" \
      >"$SIGNING_METADATA_DIRECTORY/artifacts.json"
    node scripts/release-signing-provenance-receipt.mjs verify \
      --receipt "$MANIFEST_SIGNING_RECEIPT" \
      --manifest "$(absolute_path "$MANIFEST")" \
      --expect-runtime-sha "$RUNTIME_SHA" \
      --run-metadata "$SIGNING_METADATA_DIRECTORY/run.json" \
      --artifact-metadata "$SIGNING_METADATA_DIRECTORY/artifacts.json" \
      >/dev/null || {
        echo "live manifest-signing provenance differs from the SHA-scoped receipt" >&2
        exit 1
      }
    if [ "$SIGN_REQUEST" = 1 ]; then
      if [ -e "$SIGNED_BUNDLE" ] || [ -L "$SIGNED_BUNDLE" ]; then
        SIGNED_BUNDLE_STATUS="$(
          node scripts/rollback-drill-staging-attestation.mjs \
            validate-signed \
            --bundle "$SIGNED_BUNDLE" \
            --drill-public-key \
              "$ROOT/docs/release/evidence/rollback-drill-staging-public-key.pem" \
            --production-public-key \
              "$ROOT/docs/release/evidence/release-evidence-public-key.pem"
        )"
        node - "$SIGNED_BUNDLE" "$STAGING_REQUEST" \
          "$(absolute_path "$MANIFEST")" "$STAGING_REQUEST_ID" \
          "$RUNTIME_SHA" "$DIGEST" <<'NODE'
const crypto=require('node:crypto');const fs=require('node:fs');const path=require('node:path');
const [bundle,requestFile,manifestFile,requestId,runtimeSha,artifactDigest]=
 process.argv.slice(2);
const identity=fs.lstatSync(bundle);
if(!identity.isDirectory()||identity.isSymbolicLink()
 ||identity.uid!==process.getuid()||(identity.mode&0o7777)!==0o700){
 throw new Error('signed drill bundle directory is unsafe');
}
const digest=(file)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const names=['drill-binding.json','release-manifest.json','staging-attestation.json'];
for(const name of names){
 const file=path.join(bundle,name),observed=fs.lstatSync(file);
 if(!observed.isFile()||observed.isSymbolicLink()||observed.nlink!==1
  ||observed.uid!==process.getuid()||(observed.mode&0o7777)!==0o600){
  throw new Error(`signed drill bundle file is unsafe: ${name}`);
 }
}
if(fs.readdirSync(bundle).sort().join(',')!==names.sort().join(',')){
 throw new Error('signed drill bundle has unexpected files');
}
const binding=JSON.parse(fs.readFileSync(path.join(bundle,'drill-binding.json')));
if(binding.payload?.requestId!==requestId||binding.payload?.runtimeSha!==runtimeSha
 ||binding.payload?.artifactDigest!==artifactDigest
 ||binding.payload?.source?.stagingRequestSha256!==digest(requestFile)
 ||binding.payload?.source?.releaseManifestSha256!==digest(manifestFile)){
 throw new Error('signed drill bundle differs from exact local request sources');
}
NODE
        printf '%s\n' "$SIGNED_BUNDLE_STATUS"
      else
        scripts/request-rollback-drill-staging-attestation.sh \
          "$STAGING_REQUEST" "$(absolute_path "$MANIFEST")" "$SIGNED_BUNDLE" \
          --manifest-signing-run-id "$MANIFEST_SIGNING_RUN_ID" \
          --bundle-root "$BUNDLE"
      fi
    else
      printf '{"ok":true,"staged":true,"promotable":false,"rollbackDrillEligible":false,"reason":"protected_drill_signature_required","request":"%s","rootEvidence":"%s"}\n' \
        "$STAGING_REQUEST" "$ROOT_EVIDENCE"
    fi
    ;;
  status)
    if [ ! -f "$(absolute_path "$MANIFEST")" ]; then
      printf '{"ok":false,"promotable":false,"reason":"manifest_missing","manifest":"%s"}\n' "$MANIFEST"
      exit 1
    fi
    validate_manifest
    if [ "${NEXUS_RELEASE_STATUS_REQUIRE_STAGING:-0}" = "1" ]; then
      RUNTIME_SHA="$(manifest_field payload.runtimeSha)"
      DIGEST="$(manifest_field payload.artifact.digest)"
      validate_staging_attestation "$RUNTIME_SHA" "$DIGEST"
    fi
    ;;
  prepare)
    echo "NOTICE: release:prepare is a diagnostic/manual fallback; use release:resume for the canonical production flow." >&2
    CONTRACT_ARGS=()
    MANIFEST_EXPECTATIONS=()
    case "$CONTRACT_SCOPE" in
      backend_only)
        [ -z "$IOS_SHA$IOS_BUILD_NUMBER$IOS_CONTRACT_RESULT" ] || {
          echo "backend-only release must not include iOS contract fields" >&2
          exit 64
        }
        CONTRACT_ARGS=(--backend-only)
        MANIFEST_EXPECTATIONS=(--expect-backend-only)
        ;;
      shared_backend_ios)
        [[ "$IOS_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid iOS SHA" >&2; exit 64; }
        [[ "$IOS_BUILD_NUMBER" =~ ^[1-9][0-9]*$ ]] || { echo "invalid iOS build number" >&2; exit 64; }
        [ "$IOS_CONTRACT_RESULT" = "passed" ] || { echo "iOS contract result must be passed" >&2; exit 64; }
        CONTRACT_ARGS=(
          --includes-ios
          --ios-sha "$IOS_SHA"
          --ios-build-number "$IOS_BUILD_NUMBER"
          --ios-contract-result "$IOS_CONTRACT_RESULT"
        )
        MANIFEST_EXPECTATIONS=(
          --require-ios-contract
          --expect-ios-sha "$IOS_SHA"
          --expect-ios-build-number "$IOS_BUILD_NUMBER"
          --expect-ios-contract-result "$IOS_CONTRACT_RESULT"
        )
        ;;
      *)
        echo "release:prepare requires an explicit --backend-only or --includes-ios contract scope" >&2
        exit 64
        ;;
    esac
    [ -z "$(git status --porcelain=v1 --untracked-files=normal)" ] || {
      echo "release:prepare requires a clean exact runtime SHA" >&2
      exit 1
    }
    scripts/release-test-gate.sh --base "$BASE"
    node scripts/release-bundle.mjs --runtime-sha "$SHA"
    case "$MANIFEST" in
      *.json) UNSIGNED_MANIFEST="${MANIFEST%.json}.unsigned.json" ;;
      *) UNSIGNED_MANIFEST="$MANIFEST.unsigned.json" ;;
    esac
    node scripts/release-manifest-v2.mjs write \
      --allow-unsigned \
      --key-id unsigned-release-candidate \
      --manifest "$UNSIGNED_MANIFEST" \
      "${CONTRACT_ARGS[@]}"
    node scripts/release-manifest-v2.mjs validate-payload \
      --manifest "$UNSIGNED_MANIFEST" \
      --expect-runtime-sha "$SHA" \
      "${MANIFEST_EXPECTATIONS[@]}" >/dev/null
    printf '{"ok":true,"prepared":true,"promotable":false,"reason":"trusted_signer_required","unsignedManifest":"%s"}\n' "$UNSIGNED_MANIFEST"
    ;;
  staging)
    if ! release_require_clean_tree "$ROOT"; then
      echo "release:staging requires a clean checkout bound to the signed runtime SHA" >&2
      exit 1
    fi
    validate_manifest
    CHECKPOINT_BOUND=false
    if [ -n "$STAGING_REQUEST_ID" ]; then
      validate_staging_coordinator_checkpoint || {
        echo "staging coordinator checkpoint validation failed" >&2
        exit 1
      }
      CHECKPOINT_BOUND=true
    fi
    if [ -z "$STAGING_REQUEST_ID" ]; then
      STAGING_REQUEST_ID="$(node -e 'process.stdout.write(require("crypto").randomUUID())')"
    fi
    validate_rollback_drill_freshness
    SERVER="${DEPLOY_SERVER:-dominguez@serverdominguez}"
    BASE_DIR="${STAGING_PATH:-/srv/nexus-release/staging}"
    RELEASE_DIR="$BASE_DIR/releases/${RUNTIME_SHA}-${DIGEST:0:12}"
    SYSTEMD_CONTROL="${NEXUS_RELEASE_SYSTEMD_CONTROL:-/usr/local/sbin/nexus-release-promotion-control}"
    EVIDENCE_BASE="$ROOT/.local/release/staging/${RUNTIME_SHA}-${DIGEST}"
    mkdir -p "$(dirname "$EVIDENCE_BASE")"
    TRUSTED_STAGING_EVIDENCE="$EVIDENCE_BASE.trusted-runtime.json"
    ROOT_STAGING_EVIDENCE="$EVIDENCE_BASE.root-attestation.json"
    if [ "$DRY_RUN" = true ]; then
      printf '{"ok":true,"dryRun":true,"server":"%s","releaseDir":"%s","artifactDigest":"%s","requestId":"%s"}\n' \
        "$SERVER" "$RELEASE_DIR" "$DIGEST" "$STAGING_REQUEST_ID"
      exit 0
    fi

    # Use the same lock name as the retired staging path so a stale operator
    # cannot race exact installation or the PM2/current switch.
    trap release_cleanup_all_locks EXIT
    release_acquire_local_lock "$ROOT" "staging-deploy"
    release_acquire_remote_lock "$SERVER" "$BASE_DIR" "staging-deploy"
    release_acquire_remote_sonar_lock "$SERVER"
    CONTROL_VERSION="$(ssh "$SERVER" sudo -n "$SYSTEMD_CONTROL" version)"
    [ "$CONTROL_VERSION" = nexus-release-promotion-control.v4 ] || {
      echo "root-owned release control v4 is required before staging" >&2
      exit 75
    }
    ssh "$SERVER" sudo -n "$SYSTEMD_CONTROL" assert-layout-ready >/dev/null || {
      echo "authoritative /srv release migration is incomplete; staging remains blocked" >&2
      exit 75
    }

    # The root broker resolves and validates this root-managed PM2 path. A
    # deploy-user PATH entry is never accepted as release evidence.
    REMOTE_PM2="${NEXUS_RELEASE_REMOTE_PM2:-/usr/local/bin/pm2}"
    [ "$REMOTE_PM2" = /usr/local/bin/pm2 ] || {
      echo "staging requires the governed root-managed PM2 path" >&2
      exit 64
    }
    CAPACITY_ARGS=(--role staging --base-dir "$BASE_DIR" --pm2-bin "$REMOTE_PM2")
    ssh "$SERVER" bash -s -- "${CAPACITY_ARGS[@]}" < "$ROOT/scripts/remote-release-capacity.sh"
    scripts/env-parity-check.sh --server "$SERVER" --staging-dir "$BASE_DIR" \
      --prod-dir "${DEPLOY_PATH:-/srv/nexus-release/production}"
    ACTIVE_STAGING="$(ssh "$SERVER" bash -s -- "$BASE_DIR" <<'REMOTE_ACTIVE_STAGING'
set -euo pipefail
base_dir="$1"
if [ -L "$base_dir/current" ]; then readlink -f "$base_dir/current"; fi
REMOTE_ACTIVE_STAGING
)"
    case "$ACTIVE_STAGING" in
      ""|"$BASE_DIR"/releases/*) ;;
      *) echo "unsafe active staging runtime: $ACTIVE_STAGING" >&2; exit 1 ;;
    esac
    RSYNC_BASIS_ARGS=()
    if [ -n "$ACTIVE_STAGING" ] && [ "$ACTIVE_STAGING" != "$RELEASE_DIR" ]; then
      # The remote staging and global release locks pin this exact predecessor
      # while rsync runs. --checksum lets --copy-dest reuse identical bytes
      # even though deterministic artifact creation gives them fresh mtimes.
      # The basis is copied into the new release (never hard-linked), reducing
      # network transfer without sharing mutable inodes. The trusted
      # full-bundle verifier below remains authoritative and rejects any basis
      # or transfer drift.
      RSYNC_BASIS_ARGS=(--copy-dest="$ACTIVE_STAGING" --checksum)
    fi
    ROOT_EVIDENCE_READY=false
    SEALED_CANDIDATE=false
    if [ "$CHECKPOINT_BOUND" = true ]; then
      set +e
      ssh "$SERVER" sudo -n "$SYSTEMD_CONTROL" fetch-staging-evidence \
        "$STAGING_REQUEST_ID" > "$ROOT_STAGING_EVIDENCE"
      FETCH_EVIDENCE_STATUS=$?
      set -e
      if [ "$FETCH_EVIDENCE_STATUS" -eq 0 ]; then
        ROOT_EVIDENCE_READY=true
      elif [ "$FETCH_EVIDENCE_STATUS" -ne 66 ]; then
        echo "root-owned staging evidence lookup failed closed" >&2
        exit "$FETCH_EVIDENCE_STATUS"
      fi
    fi
    if [ "$ACTIVE_STAGING" = "$RELEASE_DIR" ]; then
      if [ "$CHECKPOINT_BOUND" != true ]; then
        echo "exact staging release is already active without a bound coordinator checkpoint: $RELEASE_DIR" >&2
        exit 75
      fi
    fi
    if [ "$ROOT_EVIDENCE_READY" = false ]; then
      set +e
      INSTALLED_RUNTIME_DIGEST="$(
        ssh "$SERVER" /usr/bin/node -e '
const fs=require("fs");const file=process.argv[1];
if(!fs.existsSync(file))process.exit(66);
const x=JSON.parse(fs.readFileSync(file,"utf8"));
if(x.schema!=="nexus.installed-runtime-attestation.v1"
 ||!/^[a-f0-9]{64}$/u.test(x.aggregateDigest||""))process.exit(1);
process.stdout.write(x.aggregateDigest);' "$RELEASE_DIR/.nexus-installed-runtime.json"
      )"
      INSTALLED_LOOKUP_STATUS=$?
      set -e
      if [ "$INSTALLED_LOOKUP_STATUS" -eq 0 ]; then
        ssh "$SERVER" sudo -n "$SYSTEMD_CONTROL" seal-staging-runtime \
          "$STAGING_REQUEST_ID" "$RELEASE_DIR" "$BASE_DIR" "$RUNTIME_SHA" "$DIGEST" \
          "$INSTALLED_RUNTIME_DIGEST" > "$TRUSTED_STAGING_EVIDENCE"
        SEALED_CANDIDATE=true
      elif [ "$INSTALLED_LOOKUP_STATUS" -eq 66 ]; then
      PREPARED_TARGET="$(
        ssh "$SERVER" sudo -n "$SYSTEMD_CONTROL" prepare-staging-runtime-target \
          "$RELEASE_DIR" "$BASE_DIR"
      )"
      node -e 'const x=JSON.parse(process.argv[1]);if(x.ok!==true||x.writable!==true)process.exit(1)' \
        "$PREPARED_TARGET" || {
        echo "staging runtime target is sealed without the checkpointed root binding" >&2
        exit 75
      }
      rsync -az --delete --stats --chmod=D700,Fu+rw,go-rwx \
        "${RSYNC_BASIS_ARGS[@]}" "$BUNDLE/" "$SERVER:$RELEASE_DIR/"
      else
        echo "staging installed-runtime evidence lookup failed closed" >&2
        exit "$INSTALLED_LOOKUP_STATUS"
      fi
    fi

    # Verify the transferred bytes with trusted operator-owned code before
    # executing any script from the candidate or creating its runtime links.
    # Calling the candidate's verifier here would let a tampered bundle attest
    # to itself.
    if [ "$ROOT_EVIDENCE_READY" = false ] && [ "$SEALED_CANDIDATE" = false ]; then
      ssh "$SERVER" /usr/bin/node - "$RELEASE_DIR" "$RUNTIME_SHA" "$DIGEST" <<'REMOTE_VERIFY_BUNDLE'
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const [rootInput, expectedRuntimeSha, expectedArtifactDigest] = process.argv.slice(2);
if (!rootInput || !/^[0-9a-f]{40}$/.test(expectedRuntimeSha ?? '')
    || !/^[0-9a-f]{64}$/.test(expectedArtifactDigest ?? '')) {
  throw new Error('trusted remote bundle verifier received invalid expected identity');
}
const root = path.resolve(rootInput);
const artifactSchema = 'nexus.release-artifact-manifest.v1';
const sha256 = (body) => crypto.createHash('sha256').update(body).digest('hex');
const isSafeRelativePath = (value) => typeof value === 'string'
  && value.length > 0
  && value.length <= 4096
  && !path.posix.isAbsolute(value)
  && !value.includes('\\')
  && !/[\u0000-\u001f\u007f]/.test(value)
  && path.posix.normalize(value) === value
  && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');

const rootStat = fs.lstatSync(root);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
  throw new Error('remote release bundle root is not a regular directory');
}

function readMetadata(relativePath) {
  const absolutePath = path.join(root, relativePath);
  const stat = fs.lstatSync(absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`remote release bundle metadata is not a regular file: ${relativePath}`);
  }
  if (stat.size > 16 * 1024 * 1024) {
    throw new Error(`remote release bundle metadata is unreasonably large: ${relativePath}`);
  }
  return JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
}

const declared = readMetadata('artifact-manifest.json');
const marker = readMetadata('.complete.json');
if (declared?.schema !== artifactSchema || !Array.isArray(declared.files)) {
  throw new Error('remote release artifact manifest schema is invalid');
}
if (declared?.git?.sha !== expectedRuntimeSha) {
  throw new Error('remote release artifact runtime SHA mismatch');
}

const files = [];
const seen = new Set();
let previousPath = null;
for (const entry of declared.files) {
  const relativePath = entry?.path;
  if (!isSafeRelativePath(relativePath)
      || relativePath === 'artifact-manifest.json'
      || relativePath === '.complete.json') {
    throw new Error(`remote release artifact path is unsafe: ${String(relativePath)}`);
  }
  if (seen.has(relativePath)) {
    throw new Error(`remote release artifact path is duplicated: ${relativePath}`);
  }
  if (previousPath !== null && previousPath >= relativePath) {
    throw new Error('remote release artifact file list is not strictly sorted');
  }
  if (!Number.isSafeInteger(entry?.size) || entry.size < 0
      || !/^[0-9a-f]{64}$/.test(entry?.sha256 ?? '')) {
    throw new Error(`remote release artifact declaration is invalid: ${relativePath}`);
  }
  seen.add(relativePath);
  previousPath = relativePath;

  const absolutePath = path.resolve(root, relativePath);
  if (!absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new Error(`remote release artifact escapes its root: ${relativePath}`);
  }
  let stat;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch {
    throw new Error(`remote release artifact is missing: ${relativePath}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`remote release artifact is not a regular file: ${relativePath}`);
  }
  const body = fs.readFileSync(absolutePath);
  const observedSha256 = sha256(body);
  if (body.length !== entry.size || observedSha256 !== entry.sha256) {
    throw new Error(`remote release artifact byte identity mismatch: ${relativePath}`);
  }
  files.push({ path: relativePath, size: body.length, sha256: observedSha256 });
}

const aggregateDigest = sha256(Buffer.from(JSON.stringify({
  schema: artifactSchema,
  files,
})));
if (declared.digest !== aggregateDigest
    || declared.digest !== expectedArtifactDigest
    || declared.fileCount !== files.length) {
  throw new Error('remote release artifact aggregate digest or file count mismatch');
}
if (marker?.schema !== 'nexus.release-bundle.v1'
    || marker.runtimeSha !== expectedRuntimeSha
    || marker.artifactDigest !== expectedArtifactDigest
    || marker.fileCount !== files.length) {
  throw new Error('remote release completion marker identity mismatch');
}

const actualEntries = new Set();
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`remote release bundle contains a symbolic link: ${relativePath}`);
    }
    if (stat.isDirectory()) {
      walk(absolutePath);
    } else if (stat.isFile()) {
      actualEntries.add(relativePath);
    } else {
      throw new Error(`remote release bundle contains an unsupported entry: ${relativePath}`);
    }
  }
}
walk(root);
const expectedEntries = new Set([
  ...files.map((entry) => entry.path),
  'artifact-manifest.json',
  '.complete.json',
]);
const actual = [...actualEntries].sort();
const expected = [...expectedEntries].sort();
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error('remote release bundle contains undeclared or missing files');
}
process.stdout.write(`${JSON.stringify({
  ok: true,
  runtimeSha: expectedRuntimeSha,
  artifactDigest: aggregateDigest,
  fileCount: files.length,
})}\n`);
REMOTE_VERIFY_BUNDLE
    fi

    if [ "$ROOT_EVIDENCE_READY" = false ] && [ "$SEALED_CANDIDATE" = false ]; then
      ssh "$SERVER" bash -s -- "$RELEASE_DIR" "$BASE_DIR" "$RUNTIME_SHA" "$DIGEST" <<'REMOTE_INSTALL'
set -euo pipefail
release_dir="$1"; base_dir="$2"; runtime_sha="$3"; artifact_digest="$4"
cd "$release_dir"
ln -sfn "$base_dir/.env" "$release_dir/.env"
ln -sfn "$base_dir/data" "$release_dir/data"
ln -sfn "$base_dir/logs" "$release_dir/logs"
/usr/bin/node scripts/release-runtime-dependencies.mjs install \
  --root "$release_dir" --python-bin /usr/bin/python3.12
/usr/bin/node scripts/release-installed-tree-attestation.mjs write \
  --root "$release_dir" --runtime-sha "$runtime_sha" --artifact-digest "$artifact_digest" >/dev/null
REMOTE_INSTALL
      INSTALLED_RUNTIME_DIGEST="$(
        ssh "$SERVER" /usr/bin/node -e '
const x=require(process.argv[1]);
if(x.schema!=="nexus.installed-runtime-attestation.v1"
 ||!/^[a-f0-9]{64}$/.test(x.aggregateDigest||""))process.exit(1);
process.stdout.write(x.aggregateDigest);' "$RELEASE_DIR/.nexus-installed-runtime.json"
      )"
      ssh "$SERVER" sudo -n "$SYSTEMD_CONTROL" seal-staging-runtime \
        "$STAGING_REQUEST_ID" "$RELEASE_DIR" "$BASE_DIR" "$RUNTIME_SHA" "$DIGEST" \
        "$INSTALLED_RUNTIME_DIGEST" > "$TRUSTED_STAGING_EVIDENCE"
      SEALED_CANDIDATE=true
    fi
    if [ "$ROOT_EVIDENCE_READY" = false ]; then
      ssh "$SERVER" sudo -n "$SYSTEMD_CONTROL" attest-staging-runtime \
        "$STAGING_REQUEST_ID" "$RELEASE_DIR" "$BASE_DIR" "$RUNTIME_SHA" "$DIGEST" \
        "${NEXUS_RELEASE_STAGING_STABILITY_SECONDS:-60}" > "$ROOT_STAGING_EVIDENCE"
      ROOT_EVIDENCE_READY=true
    fi
    IDENTITY_EVIDENCE="$EVIDENCE_BASE.identity.json"
    READINESS_EVIDENCE="$EVIDENCE_BASE.readiness.json"
    INSTALLED_EVIDENCE="$EVIDENCE_BASE.installed.json"
    RECOVERY_RUNTIME_EVIDENCE="$EVIDENCE_BASE.recovery-runtime.json"
    SMOKE_LOG="$EVIDENCE_BASE.smoke.log"
    REQUEST="$EVIDENCE_BASE.request.json"
    SIGNED="$EVIDENCE_BASE.signed.json"
    node - "$ROOT_STAGING_EVIDENCE" "$STAGING_REQUEST_ID" "$RELEASE_DIR" "$BASE_DIR" \
      "$RUNTIME_SHA" "$DIGEST" "$IDENTITY_EVIDENCE" "$READINESS_EVIDENCE" \
      "$INSTALLED_EVIDENCE" "$RECOVERY_RUNTIME_EVIDENCE" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const [file,requestId,releaseDir,base,runtimeSha,artifactDigest,identityOutput,
 readinessOutput,installedOutput,recoveryOutput]=process.argv.slice(2);
const record=JSON.parse(fs.readFileSync(file,'utf8'));
const canonical=(value)=>value===null||typeof value!=='object'?JSON.stringify(value)
 :Array.isArray(value)?`[${value.map(canonical).join(',')}]`
 :`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const sha256=(value)=>crypto.createHash('sha256').update(value).digest('hex');
const {binding,filesystem,currentSelector,installedRuntimeAttestation:installed,
 recoveryRuntimeAttestation:recovery,remoteIdentity,remoteReadiness}=record;
if(record.schema!=='nexus.root-staging-attestation-evidence.v1'
 ||record.requestId!==requestId||record.releaseDir!==releaseDir||record.base!==base
 ||record.runtimeSha!==runtimeSha||record.artifactDigest!==artifactDigest
 ||binding?.schema!=='nexus.trusted-staging-runtime-binding.v1'
 ||binding.requestId!==requestId||binding.runtime!==releaseDir||binding.base!==base
 ||binding.runtimeSha!==runtimeSha||binding.artifactDigest!==artifactDigest
 ||filesystem?.schema!=='nexus.release-filesystem-identity.v1'
 ||filesystem.role!=='staging'||canonical(filesystem)!==canonical(binding.filesystem)
 ||filesystem.entries?.releaseRoot?.path!=='/srv/nexus-release'
 ||filesystem.entries?.base?.path!==base
 ||filesystem.entries?.releases?.path!==`${base}/releases`
 ||filesystem.entries?.runtime?.path!==releaseDir
 ||Object.values(filesystem.entries??{}).some((entry)=>!/^[0-9]+$/u.test(entry?.dev??'')
   ||!/^[0-9]+$/u.test(entry?.ino??''))
 ||currentSelector?.schema!=='nexus.release-current-selector-identity.v1'
 ||currentSelector.path!==`${base}/current`||currentSelector.target!==releaseDir
 ||!/^[0-9]+$/u.test(currentSelector.dev??'')||!/^[0-9]+$/u.test(currentSelector.ino??'')
 ||installed?.schema!=='nexus.installed-runtime-attestation.v1'
 ||installed.aggregateDigest!==binding.installedRuntimeDigest
 ||recovery?.schema!=='nexus.recovery-runtime-attestation.v1'
 ||recovery.aggregateDigest!==binding.recoveryRuntimeDigest
 ||remoteIdentity?.schema!=='nexus.pm2-release-identity.v1'
 ||remoteReadiness?.schema!=='nexus.release-readiness.v1'
 ||remoteReadiness.role!=='staging'||remoteReadiness.runtimeSha!==runtimeSha
 ||record.outputDigests?.bindingSha256!==sha256(canonical(binding))
 ||record.outputDigests?.installedRuntimeSha256!==sha256(canonical(installed))
 ||record.outputDigests?.recoveryRuntimeSha256!==sha256(canonical(recovery))
 ||record.outputDigests?.pm2IdentitySha256!==sha256(canonical(remoteIdentity))
 ||record.outputDigests?.currentSelectorSha256!==sha256(canonical(currentSelector))
 ||record.outputDigests?.readinessSha256!==sha256(`${JSON.stringify(remoteReadiness,null,2)}\n`)
 ||!Number.isFinite(Date.parse(record.transaction?.startedAt??''))
 ||!Number.isFinite(Date.parse(record.transaction?.readinessCompletedAt??''))
 ||!Number.isFinite(Date.parse(record.transaction?.publishedAt??''))) {
 throw new Error('root staging attestation evidence is invalid or not exact');
}
for(const [output,value] of [
 [identityOutput,remoteIdentity],[readinessOutput,remoteReadiness],
 [installedOutput,installed],[recoveryOutput,recovery],
]){
 fs.writeFileSync(output,`${JSON.stringify(value,null,2)}\n`,{mode:0o600,flag:'w'});
 fs.chmodSync(output,0o600);
}
NODE
    SMOKE_CLASSIFIER_BASE_SHA="$(
      manifest_field payload.testPolicy.results.selection.baseSha
    )" || {
      echo "signed release test selection base SHA is missing" >&2
      exit 1
    }
    [[ "$SMOKE_CLASSIFIER_BASE_SHA" =~ ^[0-9a-f]{40}$ ]] \
      && git merge-base --is-ancestor "$SMOKE_CLASSIFIER_BASE_SHA" "$RUNTIME_SHA" || {
      echo "signed release test selection base is invalid for staging smoke" >&2
      exit 1
    }
    SMOKE_STARTED_EPOCH="$(date +%s)"
    set +e
    STAGING_PATH="$RELEASE_DIR" \
      NEXUS_SMOKE_CLASSIFIER_BASE_SHA="$SMOKE_CLASSIFIER_BASE_SHA" \
      NEXUS_SMOKE_DOMAIN_PROBES=1 \
      NEXUS_SMOKE_EVIDENCE=0 \
      scripts/staging-smoke.sh > "$SMOKE_LOG" 2>&1
    SMOKE_STATUS=$?
    set -e
    SMOKE_DURATION_SECONDS=$(($(date +%s) - SMOKE_STARTED_EPOCH))
    printf 'release optimization telemetry: {"schema":"nexus.release-optimization-telemetry.v1","metric":"staging-smoke","elapsedSeconds":%s,"advisory":true}\n' \
      "$SMOKE_DURATION_SECONDS" >> "$SMOKE_LOG"
    if [ "$SMOKE_STATUS" -ne 0 ]; then
      sed -n '1,240p' "$SMOKE_LOG" >&2
      echo "candidate domain smoke failed; staging is not attestable" >&2
      exit 1
    fi
    node scripts/release-staging-attestation.mjs request \
      --manifest "$MANIFEST" \
      --installed-attestation "$INSTALLED_EVIDENCE" \
      --recovery-runtime-attestation "$RECOVERY_RUNTIME_EVIDENCE" \
      --identity-evidence "$IDENTITY_EVIDENCE" \
      --readiness-evidence "$READINESS_EVIDENCE" \
      --smoke-log "$SMOKE_LOG" \
      --release-dir "$RELEASE_DIR" \
      --request-id "$STAGING_REQUEST_ID" \
      --output "$REQUEST"
    if [ "$SIGN_REQUEST" = "1" ]; then
      scripts/request-staging-attestation.sh "$REQUEST" "$MANIFEST" "$SIGNED"
    else
      printf '{"ok":true,"staged":true,"promotable":false,"reason":"detached_signature_required","request":"%s"}\n' "$REQUEST"
    fi
    ;;
  promote)
    if ! release_require_clean_tree "$ROOT"; then
      echo "release:promote requires a clean checkout bound to the signed runtime SHA" >&2
      exit 1
    fi
    # Resolve only cheap, bounded metadata here. The enforced release reward
    # check below owns the single immediate full manifest, bundle, and signed
    # staging validation before any remote production action.
    resolve_manifest_bundle
    VERSION="$(manifest_field payload.packageVersion)"
    resolve_staging_attestation "$RUNTIME_SHA" "$DIGEST"
    validate_rollback_drill_freshness
    [ "${NEXUS_RELEASE_OWNER_AUTHORIZED:-0}" = "1" ] || {
      echo "promotion requires explicit owner authorization: NEXUS_RELEASE_OWNER_AUTHORIZED=1" >&2
      exit 1
    }
    node scripts/reward-check.mjs --area release --enforce \
      --release-manifest "$MANIFEST" --require-staging \
      --staging-attestation "$STAGING_ATTESTATION"
    if [ "$DRY_RUN" = true ]; then
      printf '{"ok":true,"dryRun":true,"manifest":"%s","stagingAttestation":"%s","exactStagedArtifact":true,"emergencyRecoveryRetained":true}\n' "$MANIFEST" "$STAGING_ATTESTATION"
      exit 0
    fi
    INSTALLED_DIGEST="$(node -e 'const x=require(process.argv[1]);process.stdout.write(x.payload.installedRuntimeDigest);' "$(absolute_path "$STAGING_ATTESTATION")")"
    RECOVERY_RUNTIME_DIGEST="$(node -e 'const x=require(process.argv[1]);process.stdout.write(x.payload.recoveryRuntimeDigest);' "$(absolute_path "$STAGING_ATTESTATION")")"
    SERVER="${DEPLOY_SERVER:-dominguez@serverdominguez}"
    STAGING_BASE="${STAGING_PATH:-/srv/nexus-release/staging}"
    PROD_BASE="${DEPLOY_PATH:-/srv/nexus-release/production}"
    SYSTEMD_CONTROL="${NEXUS_RELEASE_SYSTEMD_CONTROL:-/usr/local/sbin/nexus-release-promotion-control}"
    ssh "$SERVER" sudo -n "$SYSTEMD_CONTROL" assert-layout-ready >/dev/null || {
      echo "authoritative /srv release migration is incomplete; promotion remains blocked" >&2
      exit 75
    }
    scripts/promote-exact-release.sh \
      "$SERVER" "$STAGING_BASE" "$PROD_BASE" "$RUNTIME_SHA" "$DIGEST" "$VERSION" \
      "$INSTALLED_DIGEST" "$RECOVERY_RUNTIME_DIGEST" "$(absolute_path "$MANIFEST")" \
      "$(absolute_path "$STAGING_ATTESTATION")"
    ;;
  *) echo "Unknown release command: $COMMAND" >&2; exit 64 ;;
esac
