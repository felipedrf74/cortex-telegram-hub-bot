-- 305: Durable, privacy-safe Coach V2 soak evidence.
--
-- Rule firings are content-free identifiers bound to scoped proposals. Reviews
-- are one immutable label per firing. Accepted week observations let the
-- operator calculate seven-day churn across restarts and replicas.

CREATE TABLE IF NOT EXISTS training_coach_v2_rule_firings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  proposal_id TEXT NOT NULL,
  rule_id TEXT NOT NULL CHECK (
    length(rule_id) BETWEEN 1 AND 120
    AND rule_id NOT GLOB '*[^a-z0-9_+.-]*'
  ),
  fired_at TEXT NOT NULL,
  UNIQUE (tenant_id, user_id, proposal_id, rule_id)
);

CREATE INDEX IF NOT EXISTS idx_training_coach_v2_rule_firings_window
  ON training_coach_v2_rule_firings(fired_at, rule_id);

CREATE TABLE IF NOT EXISTS training_coach_v2_rule_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  proposal_id TEXT NOT NULL,
  rule_id TEXT NOT NULL CHECK (
    length(rule_id) BETWEEN 1 AND 120
    AND rule_id NOT GLOB '*[^a-z0-9_+.-]*'
  ),
  outcome TEXT NOT NULL CHECK (outcome IN ('correct', 'incorrect')),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 160),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  reviewed_at TEXT NOT NULL,
  UNIQUE (tenant_id, user_id, proposal_id, rule_id),
  UNIQUE (tenant_id, user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_training_coach_v2_rule_reviews_window
  ON training_coach_v2_rule_reviews(reviewed_at, rule_id, outcome);

CREATE TABLE IF NOT EXISTS training_coach_v2_adaptation_observations (
  proposal_id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  plan_id INTEGER NOT NULL CHECK (plan_id > 0),
  week_id INTEGER NOT NULL CHECK (week_id > 0),
  safety_related INTEGER NOT NULL CHECK (safety_related IN (0, 1)),
  accepted_at TEXT NOT NULL,
  UNIQUE (tenant_id, user_id, proposal_id)
);

CREATE INDEX IF NOT EXISTS idx_training_coach_v2_adaptation_churn
  ON training_coach_v2_adaptation_observations(
    tenant_id, user_id, plan_id, week_id, accepted_at
  );
