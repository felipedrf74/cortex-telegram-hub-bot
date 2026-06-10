-- Materialized Decision Center ranking score. Runtime startup self-heals this column too, but
-- production/migration-only provisioning should not depend on hot-path DDL before ranked reads.
-- The migration runner skips duplicate ADD COLUMN statements, so this stays safe for databases
-- that already received the runtime compatibility column before this migration lands.

ALTER TABLE notification_center_items ADD COLUMN priority_score INTEGER;

CREATE INDEX IF NOT EXISTS idx_notification_center_decision_rank
  ON notification_center_items(user_id, tenant_id, status, priority_score DESC, created_at DESC);
