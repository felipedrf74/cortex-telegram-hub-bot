-- Roll back only the Apple notification idempotency ledger introduced by
-- migration 262.
--
-- `subscriptions.environment` is deliberately left in place. It is nullable
-- provenance that the predecessor runtime simply ignores, and dropping it on a
-- deployed database would require rebuilding the table for SQLite builds
-- without DROP COLUMN support -- a far larger risk than an inert column.

DROP INDEX IF EXISTS idx_apple_webhook_events_processed;
DROP TABLE IF EXISTS apple_webhook_events;
