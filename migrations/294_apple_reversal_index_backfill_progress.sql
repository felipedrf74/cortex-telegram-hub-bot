-- 294: bounded, progress-safe Apple reversal-index backfill.
--
-- Migration 292 left legacy inbox rows with NULL reversal indexes so runtime
-- code could decode their nested signed transaction JWS. The first bounded
-- implementation ordered only by id: 500 permanently undecodable reversals
-- could therefore occupy every pass forever and prevent a later readable
-- refund from being indexed. Non-reversal legacy rows could also consume the
-- same window even though they never participate in the fail-closed gate.
--
-- Persist the number of extraction attempts. Runtime selection filters to
-- REFUND/REVOKE and orders least-attempted rows first, so every readable row
-- receives a bounded opportunity before corrupt evidence is retried. After
-- the retry ceiling, corrupt rows stay unresolved (and therefore continue to
-- block a false clean verdict) but no longer consume automatic backfill work.
--
-- Expand only: one integer with a constant default plus plain composite
-- indexes. Older code ignores them and remains predecessor-compatible.

ALTER TABLE apple_notification_inbox
  ADD COLUMN reversal_index_attempts INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_apple_inbox_reversal_backfill_due
  ON apple_notification_inbox (
    notification_type,
    reversal_indexed_at,
    reversal_index_attempts,
    id
  );

-- The migration-292 predecessor stamped some undecodable reversals with a
-- non-NULL indexed_at while leaving both identities NULL. Candidate runtime
-- treats that shape as unresolved. This second plain index makes the bounded
-- identity-missing bucket efficient without rewriting predecessor data.
CREATE INDEX IF NOT EXISTS idx_apple_inbox_reversal_identity_missing_due
  ON apple_notification_inbox (
    notification_type,
    reversal_transaction_id,
    reversal_original_transaction_id,
    reversal_index_attempts,
    id
  );
