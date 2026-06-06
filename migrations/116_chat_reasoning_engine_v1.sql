-- Chat Reasoning Engine v1
-- Durable action plans and native task checklist support.

BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS chat_action_plans (
  action_plan_id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  source_message_id TEXT NOT NULL,
  client_request_id TEXT,
  status TEXT NOT NULL CHECK (
    status IN (
      'draft',
      'awaiting_clarification',
      'awaiting_confirmation',
      'executing',
      'completed',
      'partial_failure',
      'failed',
      'canceled',
      'expired'
    )
  ),
  frame_json TEXT NOT NULL,
  steps_json TEXT NOT NULL DEFAULT '[]',
  created_entity_refs_json TEXT NOT NULL DEFAULT '[]',
  rollback_token TEXT,
  correlation_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_action_plans_message
  ON chat_action_plans (tenant_id, user_id, source_message_id);

CREATE INDEX IF NOT EXISTS idx_chat_action_plans_scope_status
  ON chat_action_plans (tenant_id, user_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_chat_action_plans_correlation
  ON chat_action_plans (correlation_id);

CREATE TABLE IF NOT EXISTS native_task_checklist_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  is_checked INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES native_tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_native_task_checklist_scope
  ON native_task_checklist_items (user_id, task_id, position, id);

COMMIT;
