-- Chat Core v2 online eval samples.
-- Stores references to redacted replay bundles selected for privacy-safe
-- production evals. Raw prompts/provider payloads are intentionally excluded.

CREATE TABLE IF NOT EXISTS chat_v2_online_eval_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sample_id TEXT NOT NULL UNIQUE,
  turn_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  replay_bundle_id TEXT,
  route_method TEXT NOT NULL,
  domain TEXT,
  risk TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high', 'restricted')),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'personal', 'financial', 'health_adjacent', 'credential_adjacent')),
  reason TEXT NOT NULL,
  sample_rate REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('sampled', 'not_sampled', 'privacy_suppressed')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_v2_online_eval_samples_turn
  ON chat_v2_online_eval_samples(turn_id, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_chat_v2_online_eval_samples_scope
  ON chat_v2_online_eval_samples(tenant_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_v2_online_eval_samples_status_reason
  ON chat_v2_online_eval_samples(status, reason, created_at DESC);
