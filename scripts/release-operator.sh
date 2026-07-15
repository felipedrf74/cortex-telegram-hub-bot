#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/lib/release-gates.sh"
COMMAND="${1:-status}"
[ $# -gt 0 ] && shift
usage() {
  echo "Usage: scripts/release-operator.sh <prepare|staging|promote|status> [--base <sha>] [--manifest <file>] [--staging-attestation <file>] [--dry-run] [--no-sign-request]"
}
if [ "$COMMAND" = "-h" ] || [ "$COMMAND" = "--help" ]; then usage; exit 0; fi
BASE="origin/main"
MANIFEST=""
STAGING_ATTESTATION=""
DRY_RUN=false
SIGN_REQUEST="${NEXUS_RELEASE_SIGN_STAGING:-1}"
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --manifest) MANIFEST="$2"; shift 2 ;;
    --staging-attestation) STAGING_ATTESTATION="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --no-sign-request) SIGN_REQUEST=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 64 ;;
  esac
done

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

validate_manifest() {
  node scripts/release-manifest-v2.mjs validate --manifest "$MANIFEST"
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
    [ -z "$(git status --porcelain=v1 --untracked-files=normal)" ] || {
      echo "release:prepare requires a clean exact runtime SHA" >&2
      exit 1
    }
    scripts/release-test-gate.sh --base "$BASE"
    node scripts/release-bundle.mjs --runtime-sha "$SHA"
    node scripts/release-manifest-v2.mjs write --manifest "$MANIFEST"
    ;;
  staging)
    validate_manifest
    DIGEST="$(manifest_field payload.artifact.digest)"
    RUNTIME_SHA="$(manifest_field payload.runtimeSha)"
    BUNDLE="$ROOT/.local/release/bundles/$RUNTIME_SHA/$DIGEST"
    [ -f "$BUNDLE/.complete.json" ] || { echo "immutable bundle missing: $BUNDLE" >&2; exit 1; }
    SERVER="${DEPLOY_SERVER:-dominguez@serverdominguez}"
    BASE_DIR="${STAGING_PATH:-/home/dominguez/telegram-hub-bot-staging}"
    RELEASE_DIR="$BASE_DIR/releases/${RUNTIME_SHA}-${DIGEST:0:12}"
    if [ "$DRY_RUN" = true ]; then
      printf '{"ok":true,"dryRun":true,"server":"%s","releaseDir":"%s","artifactDigest":"%s"}\n' "$SERVER" "$RELEASE_DIR" "$DIGEST"
      exit 0
    fi

    # Resolve and prove the executable before creating or switching any link.
    REMOTE_PM2="$(resolve_remote_pm2 "$SERVER")"
    [ -n "$REMOTE_PM2" ] || { echo "remote PM2 binary is unavailable" >&2; exit 1; }
    ssh "$SERVER" "mkdir -p '$RELEASE_DIR' '$BASE_DIR/releases' '$BASE_DIR/data' '$BASE_DIR/logs'"
    rsync -az --delete --chmod=D700,Fu+rw,go-rwx "$BUNDLE/" "$SERVER:$RELEASE_DIR/"
    ssh "$SERVER" bash -s -- "$RELEASE_DIR" "$BASE_DIR" "$RUNTIME_SHA" "$DIGEST" "$REMOTE_PM2" <<'REMOTE'
set -euo pipefail
release_dir="$1"; base_dir="$2"; runtime_sha="$3"; artifact_digest="$4"; pm2_bin="$5"
[ -x "$pm2_bin" ] || { echo "resolved PM2 binary is no longer executable" >&2; exit 1; }
ln -sfn "$base_dir/.env" "$release_dir/.env"
ln -sfn "$base_dir/data" "$release_dir/data"
ln -sfn "$base_dir/logs" "$release_dir/logs"
cd "$release_dir"
npm ci --omit=dev
python3.12 -m venv content-engine/.venv
content-engine/.venv/bin/pip install -q --disable-pip-version-check -r content-engine/requirements.txt
node scripts/release-installed-tree-attestation.mjs write \
  --root "$release_dir" --runtime-sha "$runtime_sha" --artifact-digest "$artifact_digest" >/dev/null
# No link is mutated until PM2 and both installed dependency trees are proved.
node scripts/release-installed-tree-attestation.mjs validate \
  --root "$release_dir" --runtime-sha "$runtime_sha" --artifact-digest "$artifact_digest" >/dev/null

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
  NEXUS_RELEASE_ROLE=staging NEXUS_RELEASE_SHA="$runtime_sha" \
  "$pm2_bin" start "$release_dir/ecosystem.release.config.js" --update-env
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
    INSTALLED_EVIDENCE="$EVIDENCE_BASE.installed.json"
    SMOKE_LOG="$EVIDENCE_BASE.smoke.log"
    REQUEST="$EVIDENCE_BASE.request.json"
    SIGNED="$EVIDENCE_BASE.signed.json"
    ssh "$SERVER" "cat '$RELEASE_DIR/.nexus-pm2-identity.json'" > "$IDENTITY_EVIDENCE"
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
    DIGEST="$(manifest_field payload.artifact.digest)"
    RUNTIME_SHA="$(manifest_field payload.runtimeSha)"
    VERSION="$(manifest_field payload.packageVersion)"
    validate_staging_attestation "$RUNTIME_SHA" "$DIGEST" >/dev/null
    [ "${NEXUS_RELEASE_OWNER_AUTHORIZED:-0}" = "1" ] || {
      echo "promotion requires explicit owner authorization: NEXUS_RELEASE_OWNER_AUTHORIZED=1" >&2
      exit 1
    }
    node scripts/reward-check.mjs --area release --enforce \
      --release-manifest "$MANIFEST" --require-staging \
      --staging-attestation "$STAGING_ATTESTATION"
    if [ "$DRY_RUN" = true ]; then
      printf '{"ok":true,"dryRun":true,"manifest":"%s","stagingAttestation":"%s","exactStagedArtifact":true,"legacyFallbackRetained":true}\n' "$MANIFEST" "$STAGING_ATTESTATION"
      exit 0
    fi
    INSTALLED_DIGEST="$(node -e 'const x=require(process.argv[1]);process.stdout.write(x.payload.installedRuntimeDigest);' "$(absolute_path "$STAGING_ATTESTATION")")"
    SERVER="${DEPLOY_SERVER:-dominguez@serverdominguez}"
    STAGING_BASE="${STAGING_PATH:-/home/dominguez/telegram-hub-bot-staging}"
    PROD_BASE="${DEPLOY_PATH:-/home/dominguez/telegram-hub-bot}"
    # The legacy wrapper remains an explicit, separately invoked fallback only.
    scripts/promote-exact-release.sh \
      "$SERVER" "$STAGING_BASE" "$PROD_BASE" "$RUNTIME_SHA" "$DIGEST" "$VERSION" "$INSTALLED_DIGEST"
    ;;
  *) echo "Unknown release command: $COMMAND" >&2; exit 64 ;;
esac
