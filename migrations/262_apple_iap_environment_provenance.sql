-- 262: Record Apple StoreKit environment provenance and de-duplicate Apple
-- App Store Server Notifications.
--
-- App Review buys against the StoreKit sandbox even on an App-Store-Connect
-- distributed build, so the `environment` claim can no longer gate a grant --
-- doing so rejected every reviewer purchase. The claim is retained here as
-- provenance on the subscription row (and in audit_trail) while strict expiry
-- enforcement remains the abuse bound. The column is nullable so every existing
-- row keeps its current meaning.
--
-- `apple_webhook_events` mirrors the `stripe_webhook_events` idempotency ledger
-- from migration 148: a replayed notificationUUID must not re-apply a lifecycle
-- transition. Every statement is additive and idempotent.

ALTER TABLE subscriptions
  ADD COLUMN environment TEXT;

CREATE TABLE IF NOT EXISTS apple_webhook_events (
  notification_uuid TEXT PRIMARY KEY,
  notification_type TEXT NOT NULL,
  subtype           TEXT,
  environment       TEXT,
  processed_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_apple_webhook_events_processed
  ON apple_webhook_events(processed_at);
