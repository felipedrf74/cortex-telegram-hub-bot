#!/usr/bin/env bash
# Run the exact candidate migration runner against an online SQLite backup clone.
# Output is aggregate evidence only; the clone is removed before JSON is emitted.
set -euo pipefail
umask 077

RELEASE_DIR="${1:?release dir is required}"
PRODUCTION_BASE="${2:?production base is required}"
CURRENT_RUNTIME="${3:?current runtime is required}"
PM2_BIN="${4:?PM2 path is required}"
PREDECESSOR_SHA="${5:?predecessor SHA is required}"
TARGET_SHA="${6:?target SHA is required}"
TARGET_VERSION="${7:?target version is required}"
ARTIFACT_DIGEST="${8:?artifact digest is required}"
REVIEW_EVIDENCE_SHA256="${9:?review evidence digest is required}"
MIGRATION_POLICY_SUBJECT_SHA256="${10:?migration policy subject digest is required}"
PROMOTION_RUN_ID="${11:?promotion run id is required}"
REHEARSAL_PHASE="${12:?rehearsal phase is required}"
DATABASE_OWNER_STATE="${13:?database owner state is required}"

[[ "$PRODUCTION_BASE" == "$HOME"/* ]] || { echo "unsafe production base" >&2; exit 64; }
[[ "$RELEASE_DIR" == "$PRODUCTION_BASE"/releases/* ]] || { echo "unsafe release directory" >&2; exit 64; }
case "$CURRENT_RUNTIME" in "$PRODUCTION_BASE"|"$PRODUCTION_BASE"/releases/*) ;; *) echo "unsafe predecessor runtime" >&2; exit 64 ;; esac
for governed_directory in "$PRODUCTION_BASE" "$PRODUCTION_BASE/releases" "$RELEASE_DIR" "$CURRENT_RUNTIME"; do
  [ -d "$governed_directory" ] && [ ! -L "$governed_directory" ] \
    && [ "$(readlink -f "$governed_directory")" = "$governed_directory" ] || {
    echo "production rehearsal directory identity is unsafe" >&2
    exit 64
  }
done
[[ "$PREDECESSOR_SHA" =~ ^[a-f0-9]{40}$ ]] || { echo "invalid predecessor SHA" >&2; exit 64; }
[[ "$TARGET_SHA" =~ ^[a-f0-9]{40}$ ]] || { echo "invalid target SHA" >&2; exit 64; }
[[ "$TARGET_VERSION" =~ ^[0-9A-Za-z.+-]+$ ]] || { echo "invalid target version" >&2; exit 64; }
[[ "$ARTIFACT_DIGEST" =~ ^[a-f0-9]{64}$ ]] || { echo "invalid artifact digest" >&2; exit 64; }
[[ "$REVIEW_EVIDENCE_SHA256" =~ ^[a-f0-9]{64}$ ]] || { echo "invalid review evidence digest" >&2; exit 64; }
[[ "$MIGRATION_POLICY_SUBJECT_SHA256" =~ ^[a-f0-9]{64}$ ]] || { echo "invalid migration policy digest" >&2; exit 64; }
[[ "$PROMOTION_RUN_ID" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+-[a-f0-9]{12}$ ]] || { echo "invalid promotion run id" >&2; exit 64; }
case "$REHEARSAL_PHASE:$DATABASE_OWNER_STATE" in
  online_pre_stop:online|stopped_final:stopped) ;;
  *) echo "invalid rehearsal phase or database-owner state" >&2; exit 64 ;;
esac
[ -x "$PM2_BIN" ] || { echo "PM2 is unavailable" >&2; exit 1; }
[ -f "$PRODUCTION_BASE/data/bot.db" ] && [ ! -L "$PRODUCTION_BASE/data/bot.db" ] || {
  echo "production database is missing or unsafe" >&2
  exit 1
}

"$PM2_BIN" jlist | node -e '
const fs=require("fs");const rows=JSON.parse(fs.readFileSync(0,"utf8"));
const runtime=process.argv[1],sha=process.argv[2],state=process.argv[3];
for(const [name,cwd] of [["nexus-hub",runtime],["content-engine",`${runtime}/content-engine`]]){
  const row=rows.find((entry)=>entry?.name===name),env=row?.pm2_env??{};
  const statusOk=state==="online"?env.status==="online":env.status==="stopped"&&Number(row?.pid||0)===0;
  if(!statusOk||env.pm_cwd!==cwd||(sha&&(env.NEXUS_RELEASE_SHA||env.GIT_COMMIT)!==sha))process.exit(1);
}' "$CURRENT_RUNTIME" "$PREDECESSOR_SHA" "$DATABASE_OWNER_STATE" || {
  echo "database-owning predecessor processes do not match the required exact state" >&2
  exit 1
}

cd "$RELEASE_DIR"
rehearsal_output="$(NODE_ENV=production node scripts/production-shape-migration-rehearsal.mjs \
  --release-dir "$RELEASE_DIR" \
  --production-base "$PRODUCTION_BASE" \
  --source-database "$PRODUCTION_BASE/data/bot.db" \
  --predecessor-runtime-sha "$PREDECESSOR_SHA" \
  --target-runtime-sha "$TARGET_SHA" \
  --target-version "$TARGET_VERSION" \
  --artifact-digest "$ARTIFACT_DIGEST" \
  --review-evidence-sha256 "$REVIEW_EVIDENCE_SHA256" \
  --migration-policy-subject-sha256 "$MIGRATION_POLICY_SUBJECT_SHA256" \
  --promotion-run-id "$PROMOTION_RUN_ID" \
  --phase "$REHEARSAL_PHASE" \
  --database-owner-state "$DATABASE_OWNER_STATE")"
if [ "$DATABASE_OWNER_STATE" = stopped ]; then
  command -v fuser >/dev/null 2>&1 || { echo "fuser is required for final rehearsal handle proof" >&2; exit 1; }
  for database_file in "$PRODUCTION_BASE/data/bot.db" "$PRODUCTION_BASE/data/bot.db-wal" "$PRODUCTION_BASE/data/bot.db-shm"; do
    if [ -e "$database_file" ] && fuser -s "$database_file"; then
      echo "final rehearsal left a production database handle open" >&2
      exit 1
    fi
  done
fi
printf '%s\n' "$rehearsal_output"
