CREATE TABLE IF NOT EXISTS chat_action_runs (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  account_id TEXT,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  normalized_action_hash TEXT NOT NULL,
  provider TEXT,
  action_type TEXT NOT NULL,
  status TEXT NOT NULL,
  risk TEXT NOT NULL,
  request_json TEXT NOT NULL,
  result_json TEXT,
  provider_object_id TEXT,
  provider_transaction_id TEXT,
  verification_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_action_idempotency
ON chat_action_runs(user_id, tenant_id, conversation_id, message_id, normalized_action_hash);

CREATE INDEX IF NOT EXISTS idx_chat_action_runs_status
ON chat_action_runs(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_chat_action_runs_user_recent
ON chat_action_runs(user_id, tenant_id, updated_at);
