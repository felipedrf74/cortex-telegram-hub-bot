-- Down for 292. Drops the reversal index columns and their indexes.
-- Safe: the columns are derived from signed_payload, which is untouched, so
-- re-running the up migration plus the backfill reproduces them exactly.

DROP INDEX IF EXISTS idx_apple_inbox_reversal_pending;
DROP INDEX IF EXISTS idx_apple_inbox_reversal_original_txn;
DROP INDEX IF EXISTS idx_apple_inbox_reversal_txn;

ALTER TABLE apple_notification_inbox DROP COLUMN reversal_indexed_at;
ALTER TABLE apple_notification_inbox DROP COLUMN reversal_original_transaction_id;
ALTER TABLE apple_notification_inbox DROP COLUMN reversal_transaction_id;
