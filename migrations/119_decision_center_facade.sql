-- Decision Center facade over the durable notification orchestrator.
-- Decision Center remains the source of truth for user judgment/action.
--
-- SQLite does not support ALTER TABLE ... ADD COLUMN IF NOT EXISTS. Runtime
-- startup calls ensureDecisionCenterTables(), which adds snoozed_until and
-- action_result_json with a PRAGMA table_info guard. Keeping this migration
-- to idempotent CREATE statements prevents replay failures on local/staging
-- clones while preserving the live guarded column creation path.

CREATE TABLE IF NOT EXISTS _migration_119_decision_center_marker (
  run_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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
