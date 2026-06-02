-- WP-08 (2026-05-30): Chat Core v2 trace-span retention column.
--
-- Adds a nullable `expires_at` to `chat_v2_trace_spans` so the midnight
-- data-retention cron can age out shadow trace rows by policy. Mirrors the
-- existing `chat_v2_replay_bundles.expires_at` retention pattern.
--
-- MIGRATION NUMBER = 172 (reserved by §5.C of the orchestrator build plan).
--   The migration RUNNER (`src/services/database.ts > runMigrations`) tracks
--   applied migrations by FILENAME, not by "above the max numeric prefix", so a
--   172 landing AFTER 173 (WP-07's auto-revert ledger) is applied normally —
--   its filename is simply not yet in `_migrations`. No prefix collision: 172 is
--   otherwise unused.
--
-- This WP only ADDS the column + backfill. It does NOT recreate the
-- `chat_v2_trace_spans` table (migration 161 owns it) and does NOT recreate
-- `chat_v2_auto_revert_decisions` (migration 173 / WP-07 owns it).
--
-- Idempotency: the column-add is a single-line `ALTER TABLE ... ADD COLUMN`.
-- `runMigrations` strips that exact line via
-- `filterAlreadyAppliedAddColumnStatements` when the column already exists (e.g.
-- after `ensureChatCoreV2TraceTables` added it to a fresh DB first), so the add
-- never double-applies. Keep the ADD COLUMN on ONE line so that filter matches.

ALTER TABLE chat_v2_trace_spans ADD COLUMN expires_at TEXT;

-- Backfill existing rows from started_at + the window implied by retention_policy.
-- Only rows whose expires_at is still NULL are touched, so re-running is a no-op
-- and a fresh-DB (column added by ensureChatCoreV2TraceTables, then this UPDATE
-- runs against zero rows) is safe.
--
--   '30d'            => started_at + 30 days
--   '90d'            => started_at + 90 days
--   '1y'             => started_at + 365 days
--   'legal_required' => LEFT NULL  (compliance sentinel; never auto-deleted)
--
-- A row with retention_policy = 'legal_required' is intentionally NOT matched by
-- any branch below, so its expires_at stays NULL and the cron never expires it.
UPDATE chat_v2_trace_spans
SET expires_at = datetime(started_at, '+30 days')
WHERE expires_at IS NULL AND retention_policy = '30d';

UPDATE chat_v2_trace_spans
SET expires_at = datetime(started_at, '+90 days')
WHERE expires_at IS NULL AND retention_policy = '90d';

UPDATE chat_v2_trace_spans
SET expires_at = datetime(started_at, '+365 days')
WHERE expires_at IS NULL AND retention_policy = '1y';

CREATE INDEX IF NOT EXISTS idx_chat_v2_trace_spans_retention
  ON chat_v2_trace_spans(retention_policy, expires_at);
