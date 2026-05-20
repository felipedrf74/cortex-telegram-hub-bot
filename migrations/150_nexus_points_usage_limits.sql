-- Migration 150: Nexus Points, margin-safe plan caps, and model pricing status.
--
-- Nexus Points are user-facing usage credits. Internally they map to USD AI
-- cost allowance at 1 point = $0.001 and expire 30 days after purchase.
-- This migration supersedes migrations 069 and 075 for Pro/Max daily AI caps.

UPDATE plan_configs
SET daily_cost_usd = CASE plan_id
  WHEN 'pro' THEN 0.04
  WHEN 'max' THEN 0.06
  ELSE daily_cost_usd
END,
allowed_skills_json = CASE plan_id
  WHEN 'pro' THEN '["secretary","triathlon","training","content","cooking","finance"]'
  WHEN 'max' THEN '["secretary","triathlon","training","content","cooking","finance"]'
  WHEN 'owner' THEN '["secretary","triathlon","training","content","cooking","finance"]'
  ELSE allowed_skills_json
END,
updated_at = datetime('now')
WHERE plan_id IN ('pro', 'max', 'owner');

UPDATE users
SET daily_cost_limit_usd = CASE tier
  WHEN 'pro' THEN 0.04
  WHEN 'max' THEN 0.06
  ELSE daily_cost_limit_usd
END
WHERE tier IN ('pro', 'max');

CREATE TABLE IF NOT EXISTS user_ai_budget_overrides (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL UNIQUE,
  daily_cost_usd  REAL NOT NULL CHECK (daily_cost_usd >= 0),
  reason          TEXT,
  expires_at      TEXT,
  active          INTEGER NOT NULL DEFAULT 1,
  updated_by      INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_user_ai_budget_overrides_active
  ON user_ai_budget_overrides(user_id, active, expires_at);

CREATE TABLE IF NOT EXISTS nexus_point_credits (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                  INTEGER NOT NULL,
  source                   TEXT NOT NULL DEFAULT 'purchase',
  provider                 TEXT NOT NULL,
  product_id               TEXT NOT NULL,
  provider_transaction_id  TEXT NOT NULL,
  points_granted           REAL NOT NULL CHECK (points_granted >= 0),
  points_remaining         REAL NOT NULL CHECK (points_remaining >= 0),
  usd_allowance_granted    REAL NOT NULL CHECK (usd_allowance_granted >= 0),
  usd_allowance_remaining  REAL NOT NULL CHECK (usd_allowance_remaining >= 0),
  purchased_at             TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at               TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active','exhausted','expired','refunded','revoked')),
  metadata_json            TEXT NOT NULL DEFAULT '{}',
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, provider_transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_nexus_point_credits_user_active
  ON nexus_point_credits(user_id, status, expires_at);

CREATE TABLE IF NOT EXISTS nexus_point_debits (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  credit_id         INTEGER NOT NULL,
  user_id           INTEGER NOT NULL,
  points_debited    REAL NOT NULL CHECK (points_debited >= 0),
  usd_cost_debited  REAL NOT NULL CHECK (usd_cost_debited >= 0),
  api_usage_id      INTEGER,
  category          TEXT,
  metadata_json     TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (credit_id) REFERENCES nexus_point_credits(id)
);

CREATE INDEX IF NOT EXISTS idx_nexus_point_debits_user_created
  ON nexus_point_debits(user_id, created_at);

ALTER TABLE api_usage ADD COLUMN pricing_status TEXT NOT NULL DEFAULT 'resolved';
ALTER TABLE api_usage ADD COLUMN pricing_model_key TEXT;
