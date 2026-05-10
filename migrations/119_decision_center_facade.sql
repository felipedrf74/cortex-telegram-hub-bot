-- Decision Center facade over the durable notification orchestrator.
-- Decision Center remains the source of truth for user judgment/action.

ALTER TABLE notification_center_items ADD COLUMN snoozed_until TEXT;
ALTER TABLE notification_center_items ADD COLUMN action_result_json TEXT;

CREATE TABLE IF NOT EXISTS decision_action_executions (
  action_execution_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  executor_skill TEXT NOT NULL,
  status TEXT NOT NULL,
  expected_effect_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  failed_at TEXT,
  error_code TEXT,
  UNIQUE(decision_id, action_id, user_id, tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_decision_action_scope
  ON decision_action_executions(user_id, tenant_id, decision_id, action_id);

CREATE INDEX IF NOT EXISTS idx_notification_center_decision_home
  ON notification_center_items(user_id, tenant_id, status, priority, created_at);
