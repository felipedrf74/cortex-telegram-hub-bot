-- Chat Core v2 model-run audit and replay bundles.
-- Stores versioned model/config metadata and redacted replay bundles only.
-- Full replay payloads must be encrypted by the caller before persistence.

CREATE TABLE IF NOT EXISTS chat_v2_model_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_run_id TEXT NOT NULL UNIQUE,
  turn_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('openai', 'anthropic', 'google', 'local', 'other')),
  model TEXT NOT NULL,
  model_version TEXT,
  model_settings_hash TEXT NOT NULL,
  prompt_template_version TEXT NOT NULL,
  tool_schema_set_version TEXT NOT NULL,
  context_builder_version TEXT NOT NULL,
  router_version TEXT NOT NULL,
  entity_resolver_version TEXT,
  reasoning_policy_version TEXT NOT NULL,
  input_token_count INTEGER NOT NULL DEFAULT 0,
  cached_input_token_count INTEGER NOT NULL DEFAULT 0,
  output_token_count INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('success', 'schema_failed', 'refused', 'timeout', 'error')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_v2_replay_bundles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  replay_bundle_id TEXT NOT NULL UNIQUE,
  turn_id TEXT NOT NULL,
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'personal', 'financial', 'health_adjacent', 'credential_adjacent')),
  retention_policy TEXT NOT NULL CHECK (retention_policy IN ('30d', '90d', '1y', 'legal_required')),
  redacted_bundle_json TEXT NOT NULL,
  encrypted_full_bundle TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_chat_v2_model_runs_turn
  ON chat_v2_model_runs(turn_id, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_chat_v2_model_runs_status
  ON chat_v2_model_runs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_v2_replay_bundles_turn
  ON chat_v2_replay_bundles(turn_id, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_chat_v2_replay_bundles_retention
  ON chat_v2_replay_bundles(retention_policy, expires_at);
