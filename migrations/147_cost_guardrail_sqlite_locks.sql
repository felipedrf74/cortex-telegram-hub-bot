-- 147: Cost guardrail SQLite advisory locks
--
-- PM2 can run multiple Node processes, so the per-user AI spend guard cannot
-- rely on process-local mutexes. This table provides a small SQLite-backed
-- advisory lock for check+provider-call+usage-write critical sections.

CREATE TABLE IF NOT EXISTS cost_guardrail_locks (
  lock_key TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  acquired_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cost_guardrail_locks_expires
  ON cost_guardrail_locks(expires_at_ms);
