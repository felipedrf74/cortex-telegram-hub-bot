# Cooking + Training - production-predeploy DB snapshot

Date: 2026-05-01

## Verdict

Production-predeploy DB snapshot is REQUIRED before this release is promoted.

## Why snapshot is required

The backend candidate includes schema/data changes:

- `migrations/102_cooking_tenant_scope_and_intelligence.sql`
- `migrations/103_cooking_intelligence_candidate_version.sql`
- `migrations/104_cooking_pantry_items.sql`
- `migrations/105_cooking_preference_memory_candidate.sql`
- `migrations/106_cooking_cross_skill_context_candidate.sql`

These migrations add Cooking tenant/scope metadata, create pantry storage, and update Cooking skill-version metadata. Rollback should use a verified DB backup instead of manual down-migration.

## Environment to snapshot

- Production host: `serverdominguez`
- Production app directory: `/home/dominguez/telegram-hub-bot`
- Production DB path: `/home/dominguez/telegram-hub-bot/data/bot.db`
- Backup directory used by deployment tooling: `/home/dominguez/backups/nexushub`

## Required approvals

Before running production snapshot or promotion:

1. Owner explicitly approves the production promotion step.
2. Owner explicitly approves the production DB snapshot.
3. Operator confirms no production calendar/test-data confusion.
4. Operator confirms staging RC remains the intended release candidate.

## Preferred snapshot path

The production deploy path in `scripts/deploy.sh` already stops the production PM2 process and creates a backup that includes `data/bot.db`, `data/bot.db-wal`, and `data/bot.db-shm` when present.

Required evidence from the production deploy log:

- Backup created under `/home/dominguez/backups/nexushub`.
- Backup includes `bot.db`.
- Backup size is non-zero.
- Production health check runs only after backup and deploy.

## Manual predeploy snapshot command

If the owner wants an explicit predeploy snapshot before running the production deploy script, use this pattern after approval:

```bash
ssh dominguez@serverdominguez '
set -euo pipefail
PROD_DIR=/home/dominguez/telegram-hub-bot
BACKUP_DIR=/home/dominguez/backups/nexushub/predeploy
STAMP=$(date -u +%Y%m%d-%H%M%S)
BACKUP="$BACKUP_DIR/cooking-training-predeploy-$STAMP"
mkdir -p "$BACKUP"
cp "$PROD_DIR/data/bot.db" "$BACKUP/bot.db"
[ -f "$PROD_DIR/data/bot.db-wal" ] && cp "$PROD_DIR/data/bot.db-wal" "$BACKUP/bot.db-wal"
[ -f "$PROD_DIR/data/bot.db-shm" ] && cp "$PROD_DIR/data/bot.db-shm" "$BACKUP/bot.db-shm"
sha256sum "$BACKUP"/bot.db*
cd "$PROD_DIR"
BACKUP_DB="$BACKUP/bot.db" node - <<'"'"'NODE'"'"'
const Database = require("better-sqlite3");
const db = new Database(process.env.BACKUP_DB, { readonly: true });
const result = db.pragma("integrity_check");
console.log(JSON.stringify(result));
db.close();
NODE
echo "$BACKUP"
'
```

Notes:

- Use Node plus `better-sqlite3` for the integrity check because the remote environment may not have the `sqlite3` CLI installed.
- If WAL mode is active, copy `bot.db-wal` and `bot.db-shm` with the DB file unless the app has been fully stopped and checkpointed.
- Do not run broad cleanup or data mutation during snapshot.

## Verification command

After the snapshot exists, verify it contains a readable SQLite database:

```bash
ssh dominguez@serverdominguez '
set -euo pipefail
PROD_DIR=/home/dominguez/telegram-hub-bot
BACKUP_DB=/home/dominguez/backups/nexushub/predeploy/<snapshot-dir>/bot.db
cd "$PROD_DIR"
BACKUP_DB="$BACKUP_DB" node - <<'"'"'NODE'"'"'
const Database = require("better-sqlite3");
const db = new Database(process.env.BACKUP_DB, { readonly: true });
console.log(db.pragma("integrity_check"));
for (const table of ["users", "recipes", "meal_plans", "shopping_lists", "skill_versions"]) {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
    console.log(`${table}: ${row.count}`);
  } catch (error) {
    console.log(`${table}: unavailable (${error.message})`);
  }
}
db.close();
NODE
'
```

## Rollback restore path

Use the existing rollback tooling:

```bash
./scripts/rollback.sh --dry-run latest
./scripts/rollback.sh latest
```

The rollback script uses backups from `/home/dominguez/backups/nexushub` and refuses data-unsafe code-only backups for apply mode.

## Migration rollback caveats

- Migrations 102-106 are not treated as safely reversible in place.
- Restoring `data/bot.db` from a verified backup is the safest rollback path.
- If production promotion proceeds, preserve the backup path and checksum in the promotion log.
- Do not manually delete Cooking scope, pantry, or skill-version rows as a rollback substitute.
