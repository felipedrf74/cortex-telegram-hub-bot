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
  echo "       drill-staging is fail-closed until the governed control-v2 legacy-base adapter lands"
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
    # ServerDominguez currently exposes promotion control v2 and the legacy
    # /home staging bases. Reusing the v3 /srv staging implementation here
    # would advertise a runnable first-drill path that cannot pass its own
    # control/layout gates. A later, separately reviewed adapter must provide
    # those exact v2 bindings before this entry may perform any remote action.
    echo "release:drill-staging is disabled until the governed control-v2 legacy-base adapter is installed" >&2
    printf '%s\n' '{"ok":false,"promotable":false,"rollbackDrillEligible":false,"featureEnabled":false,"reason":"governed_control_v2_legacy_base_adapter_required"}'
    exit 78
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
    [ "$CONTROL_VERSION" = nexus-release-promotion-control.v3 ] || {
      echo "root-owned release control v3 is required before staging" >&2
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
      rsync -az --delete --chmod=D700,Fu+rw,go-rwx "$BUNDLE/" "$SERVER:$RELEASE_DIR/"
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
    if ! STAGING_PATH="$RELEASE_DIR" NEXUS_SMOKE_EVIDENCE=0 scripts/staging-smoke.sh > "$SMOKE_LOG" 2>&1; then
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
    validate_manifest
    VERSION="$(manifest_field payload.packageVersion)"
    validate_staging_attestation "$RUNTIME_SHA" "$DIGEST" >/dev/null
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
