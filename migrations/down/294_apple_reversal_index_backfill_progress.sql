-- Down for 294. The attempt count is repair scheduling metadata only; signed
-- payloads and every derived reversal identity remain intact.

DROP INDEX IF EXISTS idx_apple_inbox_reversal_identity_missing_due;
DROP INDEX IF EXISTS idx_apple_inbox_reversal_backfill_due;

ALTER TABLE apple_notification_inbox DROP COLUMN reversal_index_attempts;
