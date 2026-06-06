-- Migration 151: Nexus Points settlement hardening.
--
-- Migration 150 supersedes the original 069/075 Pro/Max caps. This follow-up
-- keeps 150 immutable while making overage settlement idempotent per api_usage
-- row and separating historical pricing rows from newly resolved rows.

CREATE UNIQUE INDEX IF NOT EXISTS idx_nexus_point_debits_api_usage_id_unique
  ON nexus_point_debits(api_usage_id);

UPDATE api_usage
SET pricing_status = 'legacy'
WHERE pricing_status = 'resolved'
  AND pricing_model_key IS NULL;

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS api_usage_rebuild_137 (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                  TEXT NOT NULL DEFAULT (datetime('now')),
  category            TEXT NOT NULL,
  model               TEXT NOT NULL,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_usd            REAL NOT NULL DEFAULT 0,
  duration_ms         INTEGER NOT NULL DEFAULT 0,
  provider            TEXT DEFAULT 'anthropic',
  user_id             INTEGER NOT NULL DEFAULT 0,
  tenant_id           INTEGER NOT NULL DEFAULT 0,
  pricing_status      TEXT NOT NULL DEFAULT 'legacy',
  pricing_model_key   TEXT
);

INSERT INTO api_usage_rebuild_137 (
  id, ts, category, model, input_tokens, output_tokens,
  cache_read_tokens, cache_write_tokens, cost_usd, duration_ms,
  provider, user_id, tenant_id, pricing_status, pricing_model_key
)
SELECT
  id, ts, category, model, input_tokens, output_tokens,
  cache_read_tokens, cache_write_tokens, cost_usd, duration_ms,
  provider, user_id, tenant_id,
  CASE
    WHEN pricing_status IS NULL THEN 'legacy'
    ELSE pricing_status
  END,
  pricing_model_key
FROM api_usage;

DROP TABLE api_usage;
ALTER TABLE api_usage_rebuild_137 RENAME TO api_usage;

CREATE INDEX IF NOT EXISTS idx_api_usage_ts ON api_usage(ts);
CREATE INDEX IF NOT EXISTS idx_api_usage_category ON api_usage(category);
CREATE INDEX IF NOT EXISTS idx_api_usage_provider ON api_usage(provider);
CREATE INDEX IF NOT EXISTS idx_api_usage_user ON api_usage(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_api_usage_tenant_user_ts
  ON api_usage(tenant_id, user_id, ts);

PRAGMA foreign_keys = ON;
