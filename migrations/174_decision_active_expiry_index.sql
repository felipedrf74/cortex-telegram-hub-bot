-- Migration mirror for the A1 active-expiry partial index. The index is also created at runtime by
-- ensureDecisionCenterTables(), but mirroring it here gives fresh-DB / migration-only provisioning
-- the index that backs runDecisionExpiryJob's sweep predicate without depending on the runtime ensure
-- path running first. Idempotent (IF NOT EXISTS).

CREATE INDEX IF NOT EXISTS idx_notification_center_active_expiry
  ON notification_center_items(status, expires_at) WHERE expires_at IS NOT NULL;
