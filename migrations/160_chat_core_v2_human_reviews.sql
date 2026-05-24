-- Chat Core v2 human-review queue.
-- Stores redacted review requests for restricted, large-batch, async, or
-- policy-uncertain command proposals. Raw command payloads are deliberately
-- excluded from this table.

CREATE TABLE IF NOT EXISTS chat_v2_human_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id TEXT NOT NULL UNIQUE,
  turn_id TEXT NOT NULL,
  command_id TEXT,
  workflow_id TEXT,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  domain TEXT NOT NULL CHECK (domain IN ('secretary', 'tasks', 'training', 'content', 'cooking', 'finance', 'connections', 'notifications', 'decision_center')),
  reason TEXT NOT NULL CHECK (reason IN ('restricted_finance', 'large_batch', 'training_plan_rewrite', 'external_integration_side_effect', 'ambiguous_multi_step_plan', 'policy_uncertainty')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'changes_requested', 'cancelled', 'expired')),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'personal', 'financial', 'health_adjacent', 'credential_adjacent')),
  redacted_summary TEXT NOT NULL,
  reviewer_user_id TEXT,
  decision_note TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_chat_v2_human_reviews_pending
  ON chat_v2_human_reviews(status, requested_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_chat_v2_human_reviews_scope
  ON chat_v2_human_reviews(tenant_id, user_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_v2_human_reviews_turn
  ON chat_v2_human_reviews(turn_id, requested_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_chat_v2_human_reviews_command
  ON chat_v2_human_reviews(command_id, requested_at ASC, id ASC);
