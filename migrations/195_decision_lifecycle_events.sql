-- Decision Center lifecycle event stream (append-only).
-- One ordered row per decision state transition (created / viewed / snoozed / dismissed /
-- action_started|succeeded|failed / verified / superseded / expired / rolled_back). Feeds the
-- C3 feedback loop and observability rollups. The runtime self-heals the identical table via
-- ensureDecisionCenterTables(); this migration is the durable counterpart for the real DB.

CREATE TABLE IF NOT EXISTS decision_lifecycle_events (
  event_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  event TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  action_id TEXT,
  reason TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_decision_lifecycle_events_scope_created
  ON decision_lifecycle_events(user_id, tenant_id, decision_id, created_at);
