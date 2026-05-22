-- 153: Training operation SQLite advisory locks
--
-- Training calendar writes can be triggered by multiple entry points:
-- plan generation, explicit calendar sync, session reflow, cancellation,
-- and chat-confirmed actions. This table gives those flows a durable
-- same-user lock so PM2/multi-process deployments cannot interleave
-- provider writes and create duplicate or stale calendar state.

CREATE TABLE IF NOT EXISTS training_operation_locks (
  lock_key TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  operation TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  tenant_id INTEGER,
  plan_id INTEGER,
  acquired_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_training_operation_locks_expires
  ON training_operation_locks(expires_at_ms);

CREATE INDEX IF NOT EXISTS idx_training_operation_locks_user
  ON training_operation_locks(user_id, operation);
