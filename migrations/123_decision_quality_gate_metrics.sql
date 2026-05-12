-- Decision Center aggregate quality metrics.
-- Stores only safe categorical quality-gate facts for blocked/internal
-- decisions so ops metrics can count generic decision suppression without
-- retaining private problem statements, recommendations, or entity text.

CREATE TABLE IF NOT EXISTS decision_quality_gate_events (
  event_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  source_skill TEXT NOT NULL,
  type TEXT NOT NULL,
  quality_status TEXT NOT NULL,
  quality_score INTEGER NOT NULL DEFAULT 0,
  missing_fields_json TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL,
  generic_blocked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_decision_quality_gate_scope_created
  ON decision_quality_gate_events(user_id, tenant_id, created_at DESC);

