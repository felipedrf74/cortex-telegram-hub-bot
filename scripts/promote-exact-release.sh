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

# Chat-eval promote gate: the latest recorded local_engine chat evaluation
# run must exist and have passed before any production mutation. Produce one
# with scripts/chat-eval-local.sh. This runs locally, before any lock or SSH.
CHAT_EVAL_GATE_DB="${CHAT_EVAL_DB_PATH:-$ROOT/reports/chat-eval/chat-eval-history.sqlite}"
if [ "${NEXUS_PROMOTE_SKIP_CHAT_EVAL:-0}" = "1" ]; then
  echo "WARNING: NEXUS_PROMOTE_SKIP_CHAT_EVAL=1 — SKIPPING the local_engine chat-eval promote gate" >&2
  echo "WARNING: this promotion carries NO chat evaluation evidence; record the justification with the release evidence" >&2
else
  # NODE_PATH makes better-sqlite3 resolvable from any invocation cwd.
  NODE_PATH="$ROOT/node_modules" node -e '
    const fs = require("fs");
    const dbPath = process.argv[1];
    const runtimeSha = String(process.argv[2] || "");
    const fail = (message) => { console.error(`chat-eval gate: ${message}`); process.exit(1); };
    if (!fs.existsSync(dbPath)) {
      fail(
        `no chat-eval history database at ${dbPath}. ` +
        "The gate reads CHAT_EVAL_DB_PATH (default reports/chat-eval/chat-eval-history.sqlite); " +
        "scripts/chat-eval-local.sh may have persisted to a different, .env.local-configured CHAT_EVAL_DB_PATH " +
        "(split-brain). Align CHAT_EVAL_DB_PATH for both, then run scripts/chat-eval-local.sh first",
      );
    }
    const Database = require("better-sqlite3");
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    let row;
    try {
      row = db.prepare(
        "SELECT id, run_id, passed, git_commit, generated_at, created_at FROM chat_eval_runs " +
        "WHERE mode = ? ORDER BY created_at DESC, id DESC LIMIT 1",
      ).get("local_engine");
    } catch (error) {
      fail(`unable to read chat-eval history (${error.message}); rerun scripts/chat-eval-local.sh`);
    } finally {
      db.close();
    }
    if (!row) fail("no local_engine chat-eval run recorded; run scripts/chat-eval-local.sh first");
    if (Number(row.passed) !== 1) {
      fail(`latest local_engine run ${row.run_id} (${row.created_at}) FAILED; fix chat quality or rerun scripts/chat-eval-local.sh`);
    }
    // Stale-run guard: run-chat-eval-live.ts records git rev-parse --short=12 HEAD
    // in git_commit; refuse when the recorded run was produced on a different SHA
    // than the one being promoted. Rows with an empty git_commit stay accepted
    // (older schema / non-git contexts).
    const recordedCommit = typeof row.git_commit === "string" ? row.git_commit.trim() : "";
    if (recordedCommit && runtimeSha && !runtimeSha.startsWith(recordedCommit) && !recordedCommit.startsWith(runtimeSha)) {
      fail(`chat-eval run was recorded on ${recordedCommit}, promoting ${runtimeSha} — re-run ./scripts/chat-eval-local.sh`);
    }
    console.error(`chat-eval gate: latest local_engine run ${row.run_id} passed (${row.created_at}${recordedCommit ? `, commit ${recordedCommit}` : ""})`);
  ' "$CHAT_EVAL_GATE_DB" "$RUNTIME_SHA" || {
    echo "local_engine chat-eval gate refused promotion (loud override: NEXUS_PROMOTE_SKIP_CHAT_EVAL=1)" >&2
    exit 1
  }
fi

# Serialize exact promotion and emergency-recovery operator paths through the
# same lock name.
# The remote lock is the cross-worktree/cross-operator authority; the local
# lock prevents accidental duplicate invocation from this checkout.
trap release_cleanup_all_locks EXIT
release_acquire_local_lock "$ROOT" "prod-deploy"
release_acquire_remote_lock "$SERVER" "$PROD_BASE" "prod-deploy"

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3)
"$ROOT/scripts/env-parity-check.sh" --server "$SERVER" --staging-dir "$STAGING_BASE" --prod-dir "$PROD_BASE"
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

PREDECESSOR_SHA="$("${SSH[@]}" "$SERVER" bash -s -- "$CURRENT_RUNTIME" "$PROD_BASE" "$REMOTE_PM2" <<'REMOTE_PREDECESSOR_SHA'
set -euo pipefail
runtime="$1"; base_dir="$2"; pm2_bin="$3"
if [ "$runtime" != "$base_dir" ]; then
  node -e 'const x=require(process.argv[1]);process.stdout.write(x.runtimeSha||"")' "$runtime/.complete.json"
  exit 0
fi
"$pm2_bin" jlist | node -e '
const fs=require("fs");
const rows=JSON.parse(fs.readFileSync(0,"utf8"));
const row=rows.find((entry)=>entry?.name==="nexus-hub");
process.stdout.write(row?.pm2_env?.NEXUS_RELEASE_SHA||row?.pm2_env?.GIT_COMMIT||"");'
REMOTE_PREDECESSOR_SHA
)"
[[ "$PREDECESSOR_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  echo "active predecessor runtime SHA is unavailable" >&2
  exit 1
}
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

RELEASE_NAME="${RUNTIME_SHA}-${ARTIFACT_DIGEST:0:12}"
STAGING_RELEASE="$STAGING_BASE/releases/$RELEASE_NAME"
PROD_RELEASE="$PROD_BASE/releases/$RELEASE_NAME"
BACKUP_DIR="/home/dominguez/backups/nexushub"
PROMOTION_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PROMOTION_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$-$(node -e 'process.stdout.write(require("crypto").randomBytes(6).toString("hex"))')"

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
      online_pre_stop online 2>&1)"
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
        ].join(" "));
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
      stopped_final stopped 2>&1)"
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
        ].join(" "));
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
  "${NEXUS_RELEASE_PRODUCTION_STABILITY_SECONDS:-10}" <<'REMOTE_CUTOVER'
set -euo pipefail
release_dir="$1"; base_dir="$2"; pm2_bin="$3"; runtime_sha="$4"; target_version="$5"; public_base_url="$6"; stability_seconds="$7"
rm -f "$base_dir/current.next"
ln -s "$release_dir" "$base_dir/current.next"
mv -Tf "$base_dir/current.next" "$base_dir/current"
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
