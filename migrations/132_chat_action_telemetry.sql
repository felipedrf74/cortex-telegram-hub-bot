-- Durable chat action telemetry/replay records for hybrid action routing.
-- Stores safe routing/eval metadata only; no raw model output or private user
-- content is persisted here.

CREATE TABLE IF NOT EXISTS chat_action_telemetry (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  planner TEXT NOT NULL,
  route_tier TEXT NOT NULL,
  skill TEXT,
  action TEXT,
  status TEXT NOT NULL,
  calibrated_score REAL,
  threshold REAL,
  model_provider TEXT,
  model TEXT,
  estimated_token_cost_usd REAL,
  verifier_status TEXT,
  latency_ms INTEGER,
  outcome TEXT,
  failure_reason TEXT,
  slot_provenance_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_action_telemetry_user_created
ON chat_action_telemetry(user_id, tenant_id, created_at);

CREATE INDEX IF NOT EXISTS idx_chat_action_telemetry_route_outcome
ON chat_action_telemetry(route_tier, status, created_at);
