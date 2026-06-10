-- Client-side notification reliability telemetry.
--
-- Stores low-cardinality operational observations used by the reliability
-- dashboard: app badge reconciliation and visible read-state mutation
-- failures. Do not store notification bodies, titles, or private entity data.

CREATE TABLE IF NOT EXISTS notification_reliability_events (
  event_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  badge_count INTEGER,
  source TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notification_reliability_events_scope_type_created
  ON notification_reliability_events(user_id, tenant_id, event_type, created_at DESC);
