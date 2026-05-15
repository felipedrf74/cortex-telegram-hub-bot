CREATE TABLE IF NOT EXISTS chat_pending_actions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  account_id TEXT,
  conversation_id TEXT NOT NULL,
  action_hash TEXT NOT NULL,
  skill TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  risk_class TEXT NOT NULL,
  collected_slots_json TEXT NOT NULL,
  missing_slots_json TEXT NOT NULL,
  locale TEXT NOT NULL,
  timezone TEXT NOT NULL,
  originating_surface TEXT,
  validation_state TEXT NOT NULL,
  confirmation_state TEXT NOT NULL,
  cancellation_state TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_pending_actions_active
ON chat_pending_actions(user_id, tenant_id, conversation_id, skill, action)
WHERE status IN ('needs_input', 'needs_confirmation', 'executable');

CREATE INDEX IF NOT EXISTS idx_chat_pending_actions_lookup
ON chat_pending_actions(user_id, tenant_id, conversation_id, status, expires_at);
