-- Event backbone, background jobs, summary read models, delta sync, and budgets.
--
-- Nexus-sized modular-monolith foundation:
-- - SQLite transactional event outbox, not an external broker.
-- - SQLite job queue with leases/retries/dead-letter state.
-- - Rebuildable app summary read models.
-- - REST delta-sync cursor source from processed/persisted events.
-- - Resource budget counters for small circuit breakers.

CREATE TABLE IF NOT EXISTS event_outbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER,
  source_skill TEXT NOT NULL,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_version INTEGER NOT NULL DEFAULT 1,
  event_version INTEGER NOT NULL DEFAULT 1,
  schema_version TEXT NOT NULL DEFAULT 'event-v1',
  payload_json TEXT NOT NULL DEFAULT '{}',
  privacy_classification TEXT NOT NULL DEFAULT 'internal',
  idempotency_key TEXT NOT NULL,
  correlation_id TEXT,
  causation_id TEXT,
  request_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'processed', 'failed', 'dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before TEXT NOT NULL DEFAULT (datetime('now')),
  locked_at TEXT,
  lock_owner TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT,
  last_error TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_event_outbox_idempotency
  ON event_outbox(tenant_id, COALESCE(user_id, 0), idempotency_key);

CREATE INDEX IF NOT EXISTS idx_event_outbox_scope_created
  ON event_outbox(tenant_id, user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_event_outbox_status_due
  ON event_outbox(status, not_before, created_at);

CREATE INDEX IF NOT EXISTS idx_event_outbox_entity
  ON event_outbox(event_type, entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_event_outbox_correlation
  ON event_outbox(correlation_id);

CREATE TABLE IF NOT EXISTS background_jobs (
  job_id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER,
  job_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dead_letter', 'canceled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  not_before TEXT NOT NULL DEFAULT (datetime('now')),
  locked_at TEXT,
  lock_owner TEXT,
  idempotency_key TEXT NOT NULL,
  correlation_id TEXT,
  causation_event_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  last_error TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_background_jobs_idempotency
  ON background_jobs(tenant_id, COALESCE(user_id, 0), job_type, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_background_jobs_status_due
  ON background_jobs(status, not_before, priority, created_at);

CREATE INDEX IF NOT EXISTS idx_background_jobs_scope_created
  ON background_jobs(tenant_id, user_id, created_at);

CREATE TABLE IF NOT EXISTS product_decision_logs (
  decision_id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER,
  source_skill TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  decision_type TEXT NOT NULL,
  inputs_summary_json TEXT NOT NULL DEFAULT '{}',
  constraints_json TEXT NOT NULL DEFAULT '{}',
  decision_json TEXT NOT NULL DEFAULT '{}',
  explanation_code TEXT NOT NULL,
  confidence REAL,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  correlation_id TEXT,
  event_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_product_decision_logs_scope_created
  ON product_decision_logs(tenant_id, user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_product_decision_logs_entity
  ON product_decision_logs(source_skill, entity_type, entity_id);

CREATE TABLE IF NOT EXISTS app_summary_read_models (
  summary_id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  summary_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  source_event_sequence INTEGER,
  is_stale INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, user_id, summary_type)
);

CREATE INDEX IF NOT EXISTS idx_app_summary_scope_type
  ON app_summary_read_models(tenant_id, user_id, summary_type, updated_at);

CREATE TABLE IF NOT EXISTS sync_cursors (
  cursor_id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  cursor_value INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, user_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_cursors_scope
  ON sync_cursors(tenant_id, user_id, device_id);

CREATE TABLE IF NOT EXISTS resource_budget_counters (
  counter_id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER,
  budget_key TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_seconds INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_budget_unique
  ON resource_budget_counters(tenant_id, COALESCE(user_id, 0), budget_key, window_start);
CREATE INDEX IF NOT EXISTS idx_resource_budget_scope
  ON resource_budget_counters(tenant_id, user_id, budget_key, window_start);
