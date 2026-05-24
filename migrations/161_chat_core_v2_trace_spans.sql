-- Chat Core v2 trace spans.
-- Stores redacted workflow spans for replay, online eval sampling, and
-- production observability. Raw prompts/provider payloads are intentionally
-- excluded from the schema.

CREATE TABLE IF NOT EXISTS chat_v2_trace_spans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_span_id TEXT NOT NULL UNIQUE,
  turn_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  parent_span_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN (
    'router', 'budget', 'capability', 'context', 'entity_resolution',
    'tool_selection', 'model', 'policy', 'command', 'workflow',
    'response', 'fallback', 'guardrail', 'custom'
  )),
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'skipped', 'blocked', 'failed')),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'personal', 'financial', 'health_adjacent', 'credential_adjacent')),
  retention_policy TEXT NOT NULL CHECK (retention_policy IN ('30d', '90d', '1y', 'legal_required')),
  redacted_summary TEXT NOT NULL,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_chat_v2_trace_spans_turn
  ON chat_v2_trace_spans(turn_id, started_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_chat_v2_trace_spans_scope
  ON chat_v2_trace_spans(tenant_id, user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_v2_trace_spans_kind_status
  ON chat_v2_trace_spans(kind, status, started_at DESC);
