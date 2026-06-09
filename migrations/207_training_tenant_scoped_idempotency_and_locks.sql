-- 207: Tenant-scope Training idempotency and operation locks
--
-- Training generation idempotency and calendar operation locks are
-- health-adjacent write guards. They must be scoped by user AND tenant so
-- identical user ids or idempotency keys cannot cross tenant boundaries.
-- Existing rows predate tenant scope, so legacy data is preserved under
-- tenant_id = user_id.

CREATE TABLE IF NOT EXISTS training_plan_generation_idempotency_scoped (
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('in_progress', 'succeeded', 'failed')),
  response_json TEXT,
  status_code INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, tenant_id, idempotency_key)
);

INSERT OR IGNORE INTO training_plan_generation_idempotency_scoped (
  user_id,
  tenant_id,
  idempotency_key,
  request_hash,
  status,
  response_json,
  status_code,
  created_at,
  updated_at
)
SELECT
  user_id,
  user_id,
  idempotency_key,
  request_hash,
  status,
  response_json,
  status_code,
  created_at,
  updated_at
FROM training_plan_generation_idempotency;

CREATE INDEX IF NOT EXISTS idx_training_plan_generation_idempotency_scoped_tenant_status
  ON training_plan_generation_idempotency_scoped(tenant_id, user_id, status);

UPDATE training_operation_locks
   SET tenant_id = user_id
 WHERE tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_training_operation_locks_expires
  ON training_operation_locks(expires_at_ms);

CREATE INDEX IF NOT EXISTS idx_training_operation_locks_user_tenant_operation
  ON training_operation_locks(user_id, tenant_id, operation);
