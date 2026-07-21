-- 258: Telegram identity archive (M21 telegram purge, Stage C — 2026-07).
--
-- ARCHIVE-FIRST, NON-DESTRUCTIVE. This migration copies every non-null
-- users.telegram_id into telegram_identity_archive and touches NOTHING else.
--
-- The live users.telegram_id column is intentionally KEPT IN PLACE:
--   * the owner bootstrap (seedOwnerUser / assertOwnerBootstrapReadyForRuntime
--     in src/services/user-service.ts) still seeds and reads the persisted
--     owner row by telegram_id + OWNER_TELEGRAM_ID;
--   * the owner-gated skills override target contract (src/api/routes/
--     skills.ts) and garmin-session-store legacy resolution still read it.
--
-- FUTURE DROP POLICY: any migration that NULLs or DROPs users.telegram_id
-- must (1) land AFTER the owner-gated identity migration re-keys the owner
-- bootstrap to a non-telegram key, and (2) wait at least ONE FULL RELEASE
-- CYCLE of production soak with this archive present, so a rollback can
-- restore identity linkage from telegram_identity_archive. NEVER drop the
-- column in the same release that introduces this archive.
--
-- Reversible via migrations/down/258_telegram_identity_archive.sql (drops
-- only the archive table; the live column is untouched in both directions).
--
-- SCHEMA-ONLY MIGRATION. The archive BACKFILL deliberately does NOT live
-- here: migration rehearsals replay this file against historically-divergent
-- users schemas (the 226 repair rehearsal rebuilds users without
-- telegram_id), and SQLite cannot reference a column conditionally in pure
-- SQL. The backfill is a pragma-guarded, idempotent runtime step —
-- backfillTelegramIdentityArchive() in src/services/user-service.ts, invoked
-- from initDatabase() after migrations — which INSERT OR IGNOREs every
-- non-null users.telegram_id only when the column actually exists.

CREATE TABLE IF NOT EXISTS telegram_identity_archive (
  user_id INTEGER PRIMARY KEY,
  telegram_id INTEGER NOT NULL,
  archived_at TEXT NOT NULL DEFAULT (datetime('now'))
);
