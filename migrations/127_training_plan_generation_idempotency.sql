-- Durable idempotency guard for confirmed Training plan creation.
--
-- Preview remains non-mutating. The confirmed generate route stores the exact
-- response for a user-scoped idempotency key so retries do not cancel/recreate
-- the active plan or duplicate provider calendar writes.

CREATE TABLE IF NOT EXISTS training_plan_generation_idempotency (
  user_id INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('in_progress', 'succeeded', 'failed')),
  response_json TEXT,
  status_code INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, idempotency_key)
);
