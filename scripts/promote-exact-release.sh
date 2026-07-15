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
PUBLIC_BASE_URL="${NEXUS_PRODUCTION_PUBLIC_BASE_URL:-https://api.nexushub.me}"

[[ "$SERVER" =~ ^[A-Za-z0-9._@-]+$ ]] || { echo "invalid deploy server" >&2; exit 64; }
[[ "$STAGING_BASE" == /home/dominguez/* ]] || { echo "unsafe staging base" >&2; exit 64; }
[[ "$PROD_BASE" == /home/dominguez/* ]] || { echo "unsafe production base" >&2; exit 64; }
[[ "$RUNTIME_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid runtime SHA" >&2; exit 64; }
[[ "$ARTIFACT_DIGEST" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid artifact digest" >&2; exit 64; }
[[ "$TARGET_VERSION" =~ ^[0-9A-Za-z.+-]+$ ]] || { echo "invalid target version" >&2; exit 64; }
[[ "$INSTALLED_RUNTIME_DIGEST" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid installed runtime digest" >&2; exit 64; }
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

# Serialize exact and legacy production paths through the same lock name.
# The remote lock is the cross-worktree/cross-operator authority; the local
# lock prevents accidental duplicate invocation from this checkout.
trap release_cleanup_all_locks EXIT
release_acquire_local_lock "$ROOT" "prod-deploy"
release_acquire_remote_lock "$SERVER" "$PROD_BASE" "prod-deploy"

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3)
REMOTE_PM2="$("${SSH[@]}" "$SERVER" 'for p in "$(command -v pm2 2>/dev/null || true)" /usr/local/bin/pm2 "$HOME/.npm-global/bin/pm2"; do if [ -n "$p" ] && [ -x "$p" ]; then printf "%s" "$p"; exit 0; fi; done; exit 1')"
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
"$pm2_bin" jlist | node -e '
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

RELEASE_NAME="${RUNTIME_SHA}-${ARTIFACT_DIGEST:0:12}"
STAGING_RELEASE="$STAGING_BASE/releases/$RELEASE_NAME"
PROD_RELEASE="$PROD_BASE/releases/$RELEASE_NAME"
BACKUP_DIR="/home/dominguez/backups/nexushub"
PROMOTION_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# A lost client response after a successful cutover must never turn a retry
# into an rsync over the live immutable runtime (including temporary removal
# of its .env/data/log symlinks). The active identity was proved immediately
# above, so reject the already-active target before any release-tree mutation.
if [ "$CURRENT_RUNTIME" = "$PROD_RELEASE" ]; then
  echo "exact release is already active; refusing to mutate the live runtime: $PROD_RELEASE" >&2
  exit 75
fi

# Copy the already prepared staging runtime while production is still online.
# Verify every governed artifact byte before production is touched.
"${SSH[@]}" "$SERVER" bash -s -- \
  "$STAGING_RELEASE" "$PROD_RELEASE" "$PROD_BASE" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$INSTALLED_RUNTIME_DIGEST" <<'REMOTE_PREPARE'
set -euo pipefail
staging_release="$1"; release_dir="$2"; base_dir="$3"; runtime_sha="$4"; expected_digest="$5"; installed_digest="$6"
[ -f "$staging_release/.complete.json" ] || { echo "staged immutable release is missing" >&2; exit 1; }
node "$staging_release/scripts/release-installed-tree-attestation.mjs" validate \
  --root "$staging_release" --runtime-sha "$runtime_sha" --artifact-digest "$expected_digest" \
  --expect-runtime-sha "$runtime_sha" --expect-artifact-digest "$expected_digest" \
  --expect-aggregate-digest "$installed_digest" >/dev/null
install -d -m 700 "$base_dir/releases" "$base_dir/data" "$base_dir/logs" "$release_dir"
rsync -a --delete --chmod=D700,Fu+rw,go-rwx "$staging_release/" "$release_dir/"
for link in .env data logs; do
  if [ -L "$release_dir/$link" ]; then rm -f "$release_dir/$link";
  elif [ -e "$release_dir/$link" ]; then rm -rf "$release_dir/$link"; fi
done
ln -s "$base_dir/.env" "$release_dir/.env"
ln -s "$base_dir/data" "$release_dir/data"
ln -s "$base_dir/logs" "$release_dir/logs"
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
node "$release_dir/scripts/release-installed-tree-attestation.mjs" validate \
  --root "$release_dir" --runtime-sha "$runtime_sha" --artifact-digest "$expected_digest" \
  --expect-runtime-sha "$runtime_sha" --expect-artifact-digest "$expected_digest" \
  --expect-aggregate-digest "$installed_digest" >/dev/null
REMOTE_PREPARE

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

restart_previous() {
  "${SSH[@]}" "$SERVER" bash -s -- "$CURRENT_RUNTIME" "$PROD_BASE" "$REMOTE_PM2" <<'REMOTE_RESTART'
set -euo pipefail
runtime="$1"; base_dir="$2"; pm2_bin="$3"
[ -x "$pm2_bin" ] || { echo "PM2 is unavailable for predecessor restart" >&2; exit 1; }
previous_sha=""
for app in nexus-hub content-engine; do
  if "$pm2_bin" describe "$app" >/dev/null 2>&1; then "$pm2_bin" delete "$app" >/dev/null; fi
done
if [ "$runtime" != "$base_dir" ] && [ -f "$runtime/ecosystem.release.config.js" ]; then
  rm -f "$base_dir/current.next"
  ln -s "$runtime" "$base_dir/current.next"
  mv -Tf "$base_dir/current.next" "$base_dir/current"
  previous_sha="$(node -e 'const fs=require("fs");const p=process.argv[1];process.stdout.write(JSON.parse(fs.readFileSync(p,"utf8")).runtimeSha||"")' "$runtime/.complete.json")"
  [[ "$previous_sha" =~ ^[0-9a-f]{40}$ ]] || { echo "previous runtime SHA is invalid" >&2; exit 1; }
  env -i HOME="$HOME" PATH="$PATH" NEXUS_RELEASE_DIR="$runtime" NEXUS_RELEASE_BASE_DIR="$base_dir" \
    NEXUS_RELEASE_ROLE=production NEXUS_RELEASE_SHA="$previous_sha" \
    "$pm2_bin" start "$runtime/ecosystem.release.config.js" --update-env
else
  rm -f "$base_dir/current.next" "$base_dir/current"
  cd "$base_dir"
  "$pm2_bin" start ecosystem.config.js --update-env
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
rm -f "$base_dir/current.next" "$base_dir/current"
for app in nexus-hub content-engine; do
  if "$pm2_bin" describe "$app" >/dev/null 2>&1; then "$pm2_bin" delete "$app" >/dev/null; fi
done
if [ "$previous_runtime" != "$base_dir" ]; then
  ln -s "$previous_runtime" "$base_dir/current.next"
  mv -Tf "$base_dir/current.next" "$base_dir/current"
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
case "$BACKUP_FILE" in
  /home/dominguez/backups/nexushub/v*.tar.gz) ;;
  *) echo "backup helper returned an unsafe path" >&2; exit 1 ;;
esac

CANDIDATE_MUTATED=true
set +e
CUTOVER_OUTPUT="$("${SSH[@]}" "$SERVER" bash -s -- \
  "$PROD_RELEASE" "$PROD_BASE" "$REMOTE_PM2" "$RUNTIME_SHA" "$TARGET_VERSION" "$PUBLIC_BASE_URL" <<'REMOTE_CUTOVER'
set -euo pipefail
release_dir="$1"; base_dir="$2"; pm2_bin="$3"; runtime_sha="$4"; target_version="$5"; public_base_url="$6"
rm -f "$base_dir/current.next"
ln -s "$release_dir" "$base_dir/current.next"
mv -Tf "$base_dir/current.next" "$base_dir/current"
for app in nexus-hub content-engine; do
  if "$pm2_bin" describe "$app" >/dev/null 2>&1; then "$pm2_bin" delete "$app" >/dev/null; fi
done
env -i HOME="$HOME" PATH="$PATH" NEXUS_RELEASE_DIR="$release_dir" NEXUS_RELEASE_BASE_DIR="$base_dir" \
  NEXUS_RELEASE_ROLE=production NEXUS_RELEASE_SHA="$runtime_sha" \
  "$pm2_bin" start "$release_dir/ecosystem.release.config.js" --update-env

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
    printf 'NEXUS_PRODUCTION_VERIFICATION={"loopbackBackend":true,"loopbackContent":true,"pm2AndCurrentIdentity":true,"publicHealth":true,"publicSnapshotVersion":true}\n'
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
    loopbackBackend: true,
    loopbackContent: true,
    pm2AndCurrentIdentity: true,
    publicHealth: { baseUrl: publicBaseUrl, status: 'healthy', database: 'connected' },
    publicSnapshotVersion: packageVersion,
  },
}, null, 2)}\n`, { mode: 0o600 });
NODE
printf '{"ok":true,"runtimeSha":"%s","artifactDigest":"%s","cutoverSeconds":%s,"exactBackup":"%s"}\n' \
  "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$CUTOVER_SECONDS" "$BACKUP_FILE"
