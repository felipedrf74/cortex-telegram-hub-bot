#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/lib/release-gates.sh"
COMMAND="${1:-status}"
[ $# -gt 0 ] && shift
usage() {
  echo "Usage: scripts/release-operator.sh <prepare|staging|promote|status|resume> [--base <sha>] [--manifest <file>] [--staging-attestation <file>] [--dry-run] [--no-sign-request]"
  echo "       prepare requires exactly one contract scope: --backend-only OR --includes-ios --ios-sha <sha> --ios-build-number <number> --ios-contract-result passed"
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
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --manifest) MANIFEST="$2"; shift 2 ;;
    --staging-attestation) STAGING_ATTESTATION="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --no-sign-request) SIGN_REQUEST=0; shift ;;
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
    validate_rollback_drill_freshness
    SERVER="${DEPLOY_SERVER:-dominguez@serverdominguez}"
    BASE_DIR="${STAGING_PATH:-/home/dominguez/telegram-hub-bot-staging}"
    RELEASE_DIR="$BASE_DIR/releases/${RUNTIME_SHA}-${DIGEST:0:12}"
    if [ "$DRY_RUN" = true ]; then
      printf '{"ok":true,"dryRun":true,"server":"%s","releaseDir":"%s","artifactDigest":"%s"}\n' "$SERVER" "$RELEASE_DIR" "$DIGEST"
      exit 0
    fi

    # Use the same lock name as the retired staging path so a stale operator
    # cannot race exact installation or the PM2/current switch.
    trap release_cleanup_all_locks EXIT
    release_acquire_local_lock "$ROOT" "staging-deploy"
    release_acquire_remote_lock "$SERVER" "$BASE_DIR" "staging-deploy"
    release_acquire_remote_sonar_lock "$SERVER"

    # Resolve and prove the executable before creating or switching any link.
    REMOTE_PM2="$(resolve_remote_pm2 "$SERVER")"
    [ -n "$REMOTE_PM2" ] || { echo "remote PM2 binary is unavailable" >&2; exit 1; }
    CAPACITY_ARGS=(--role staging --base-dir "$BASE_DIR" --pm2-bin "$REMOTE_PM2")
    ssh "$SERVER" bash -s -- "${CAPACITY_ARGS[@]}" < "$ROOT/scripts/remote-release-capacity.sh"
    scripts/env-parity-check.sh --server "$SERVER" --staging-dir "$BASE_DIR" \
      --prod-dir "${DEPLOY_PATH:-/home/dominguez/telegram-hub-bot}"
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
    if [ "$ACTIVE_STAGING" = "$RELEASE_DIR" ]; then
      echo "exact staging release is already active; refusing to mutate it: $RELEASE_DIR" >&2
      exit 75
    fi
    ssh "$SERVER" "mkdir -p '$RELEASE_DIR' '$BASE_DIR/releases' '$BASE_DIR/data' '$BASE_DIR/logs'"
    rsync -az --delete --chmod=D700,Fu+rw,go-rwx "$BUNDLE/" "$SERVER:$RELEASE_DIR/"

    # Verify the transferred bytes with trusted operator-owned code before
    # executing any script from the candidate or creating its runtime links.
    # Calling the candidate's verifier here would let a tampered bundle attest
    # to itself.
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

    ssh "$SERVER" bash -s -- "$RELEASE_DIR" "$BASE_DIR" "$RUNTIME_SHA" "$DIGEST" "$REMOTE_PM2" \
      "${NEXUS_RELEASE_STAGING_STABILITY_SECONDS:-60}" <<'REMOTE'
set -euo pipefail
release_dir="$1"; base_dir="$2"; runtime_sha="$3"; artifact_digest="$4"; pm2_bin="$5"; stability_seconds="$6"
[ -x "$pm2_bin" ] || { echo "resolved PM2 binary is no longer executable" >&2; exit 1; }
[ -x /usr/bin/node ] || { echo "system Node toolchain is unavailable" >&2; exit 1; }
ln -sfn "$base_dir/.env" "$release_dir/.env"
ln -sfn "$base_dir/data" "$release_dir/data"
ln -sfn "$base_dir/logs" "$release_dir/logs"
cd "$release_dir"
/usr/bin/node scripts/release-runtime-dependencies.mjs install \
  --root "$release_dir" --python-bin /usr/bin/python3.12
/usr/bin/node scripts/release-installed-tree-attestation.mjs write \
  --root "$release_dir" --runtime-sha "$runtime_sha" --artifact-digest "$artifact_digest" >/dev/null
# No link is mutated until PM2 and both installed dependency trees are proved.
/usr/bin/node scripts/release-installed-tree-attestation.mjs validate \
  --root "$release_dir" --runtime-sha "$runtime_sha" --artifact-digest "$artifact_digest" >/dev/null
bash "$release_dir/scripts/remote-release-preflight.sh" \
  --role staging --base-dir "$base_dir" --release-dir "$release_dir" --node-bin /usr/bin/node

previous_runtime="$base_dir"
if [ -L "$base_dir/current" ]; then
  previous_runtime="$(readlink -f "$base_dir/current")"
  case "$previous_runtime" in
    "$base_dir"/releases/*) ;;
    *) echo "unsafe previous staging runtime: $previous_runtime" >&2; exit 1 ;;
  esac
  [ -f "$previous_runtime/.complete.json" ] || { echo "previous staging marker is missing" >&2; exit 1; }
fi

delete_staging_apps() {
  for app in nexus-hub-staging content-engine-staging; do
    if "$pm2_bin" describe "$app" >/dev/null 2>&1; then
      "$pm2_bin" delete "$app" >/dev/null
    fi
  done
}

restore_previous_staging() {
  set +e
  echo "staging candidate failed; restoring previous runtime $previous_runtime" >&2
  delete_staging_apps
  rm -f "$base_dir/current.next" "$base_dir/current"
  if [ "$previous_runtime" != "$base_dir" ]; then
    ln -s "$previous_runtime" "$base_dir/current.next"
    mv -Tf "$base_dir/current.next" "$base_dir/current"
    previous_sha="$(node -e 'const x=require(process.argv[1]);process.stdout.write(x.runtimeSha)' "$previous_runtime/.complete.json")"
    env -i HOME="$HOME" PATH="$PATH" NEXUS_RELEASE_DIR="$previous_runtime" NEXUS_RELEASE_BASE_DIR="$base_dir" \
      NEXUS_RELEASE_ROLE=staging NEXUS_RELEASE_SHA="$previous_sha" \
      "$pm2_bin" start "$previous_runtime/ecosystem.release.config.js" --update-env >/dev/null
  else
    cd "$base_dir"
    "$pm2_bin" start "$base_dir/ecosystem.staging.config.js" --update-env >/dev/null
  fi
  "$pm2_bin" save >/dev/null
}

switched=false
restore_on_failure() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "$switched" = true ]; then restore_previous_staging; fi
  exit "$status"
}
trap restore_on_failure EXIT

rm -f "$base_dir/current.next"
ln -s "$release_dir" "$base_dir/current.next"
mv -Tf "$base_dir/current.next" "$base_dir/current"
switched=true
delete_staging_apps
env -i HOME="$HOME" PATH="$PATH" NEXUS_RELEASE_DIR="$release_dir" NEXUS_RELEASE_BASE_DIR="$base_dir" \
  NEXUS_RELEASE_ROLE=staging NEXUS_RELEASE_SHA="$runtime_sha" SENTRY_RELEASE="$runtime_sha" \
  "$pm2_bin" start "$release_dir/ecosystem.release.config.js" --update-env
bash "$release_dir/scripts/remote-release-readiness.sh" \
  --role staging --base-dir "$base_dir" --release-dir "$release_dir" \
  --runtime-sha "$runtime_sha" --pm2-bin "$pm2_bin" --node-bin /usr/bin/node \
  --output "$release_dir/.nexus-release-readiness.json" --stability-seconds "$stability_seconds"
curl --fail --silent --show-error --retry 12 --retry-delay 2 --retry-connrefused --max-time 5 http://127.0.0.1:8201/health >/dev/null
curl --fail --silent --show-error --retry 12 --retry-delay 2 --retry-connrefused --max-time 5 http://127.0.0.1:8101/health >/dev/null
"$pm2_bin" jlist | node -e '
const fs = require("fs");
const [releaseDir, runtimeSha, output] = process.argv.slice(1);
let body = "";
process.stdin.on("data", (chunk) => { body += chunk; });
process.stdin.on("end", () => {
  const rows = JSON.parse(body);
  const expected = new Map([
    ["nexus-hub-staging", releaseDir],
    ["content-engine-staging", `${releaseDir}/content-engine`],
  ]);
  const services = [];
  for (const [name, cwd] of expected) {
    const row = rows.find((entry) => entry?.name === name);
    const env = row?.pm2_env ?? {};
    const releaseSha = env.NEXUS_RELEASE_SHA || env.GIT_COMMIT || null;
    const observed = { name, status: env.status ?? null, cwd: env.pm_cwd ?? null, releaseSha };
    if (observed.status !== "online" || observed.cwd !== cwd || observed.releaseSha !== runtimeSha) {
      throw new Error(`PM2 exact-release identity mismatch: ${name}`);
    }
    services.push(observed);
  }
  fs.writeFileSync(output, `${JSON.stringify({ schema: "nexus.pm2-release-identity.v1", services }, null, 2)}\n`, { mode: 0o600 });
});
' "$release_dir" "$runtime_sha" "$release_dir/.nexus-pm2-identity.json"
"$pm2_bin" save >/dev/null
trap - EXIT
REMOTE

    EVIDENCE_BASE="$ROOT/.local/release/staging/${RUNTIME_SHA}-${DIGEST}"
    mkdir -p "$(dirname "$EVIDENCE_BASE")"
    IDENTITY_EVIDENCE="$EVIDENCE_BASE.identity.json"
    READINESS_EVIDENCE="$EVIDENCE_BASE.readiness.json"
    INSTALLED_EVIDENCE="$EVIDENCE_BASE.installed.json"
    SMOKE_LOG="$EVIDENCE_BASE.smoke.log"
    REQUEST="$EVIDENCE_BASE.request.json"
    SIGNED="$EVIDENCE_BASE.signed.json"
    ssh "$SERVER" "cat '$RELEASE_DIR/.nexus-pm2-identity.json'" > "$IDENTITY_EVIDENCE"
    ssh "$SERVER" "cat '$RELEASE_DIR/.nexus-release-readiness.json'" > "$READINESS_EVIDENCE"
    ssh "$SERVER" "cat '$RELEASE_DIR/.nexus-installed-runtime.json'" > "$INSTALLED_EVIDENCE"
    if ! STAGING_PATH="$RELEASE_DIR" NEXUS_SMOKE_EVIDENCE=0 scripts/staging-smoke.sh > "$SMOKE_LOG" 2>&1; then
      sed -n '1,240p' "$SMOKE_LOG" >&2
      echo "candidate domain smoke failed; staging is not attestable" >&2
      exit 1
    fi
    node scripts/release-staging-attestation.mjs request \
      --manifest "$MANIFEST" \
      --installed-attestation "$INSTALLED_EVIDENCE" \
      --identity-evidence "$IDENTITY_EVIDENCE" \
      --readiness-evidence "$READINESS_EVIDENCE" \
      --smoke-log "$SMOKE_LOG" \
      --release-dir "$RELEASE_DIR" \
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
    SERVER="${DEPLOY_SERVER:-dominguez@serverdominguez}"
    STAGING_BASE="${STAGING_PATH:-/home/dominguez/telegram-hub-bot-staging}"
    PROD_BASE="${DEPLOY_PATH:-/home/dominguez/telegram-hub-bot}"
    scripts/promote-exact-release.sh \
      "$SERVER" "$STAGING_BASE" "$PROD_BASE" "$RUNTIME_SHA" "$DIGEST" "$VERSION" "$INSTALLED_DIGEST"
    ;;
  *) echo "Unknown release command: $COMMAND" >&2; exit 64 ;;
esac
