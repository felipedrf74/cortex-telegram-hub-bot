-- Rebuild event_outbox so environments that already ran migration 114 gain
-- the canceled status in SQLite's CHECK constraint. SQLite cannot ALTER CHECK
-- constraints in place, so this copy/rename migration is intentionally
-- idempotent with respect to row data and indexes.

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS event_outbox_115_new (
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
    CHECK (status IN ('pending', 'processing', 'processed', 'failed', 'dead_letter', 'canceled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before TEXT NOT NULL DEFAULT (datetime('now')),
  locked_at TEXT,
  lock_owner TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT,
  last_error TEXT
);

INSERT OR IGNORE INTO event_outbox_115_new (
  sequence,
  event_id,
  tenant_id,
  user_id,
  source_skill,
  event_type,
  entity_type,
  entity_id,
  entity_version,
  event_version,
  schema_version,
  payload_json,
  privacy_classification,
  idempotency_key,
  correlation_id,
  causation_id,
  request_id,
  status,
  attempts,
  not_before,
  locked_at,
  lock_owner,
  created_at,
  processed_at,
  last_error
)
SELECT
  sequence,
  event_id,
  tenant_id,
  user_id,
  source_skill,
  event_type,
  entity_type,
  entity_id,
  entity_version,
  event_version,
  schema_version,
  payload_json,
  privacy_classification,
  idempotency_key,
  correlation_id,
  causation_id,
  request_id,
  status,
  attempts,
  not_before,
  locked_at,
  lock_owner,
  created_at,
  processed_at,
  last_error
FROM event_outbox;

DROP TABLE event_outbox;
ALTER TABLE event_outbox_115_new RENAME TO event_outbox;

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

PRAGMA foreign_keys = ON;
