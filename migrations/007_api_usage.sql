-- Migration 007: API usage tracking for status portal
CREATE TABLE IF NOT EXISTS api_usage (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT NOT NULL DEFAULT (datetime('now')),
  category        TEXT NOT NULL,
  model           TEXT NOT NULL,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL NOT NULL DEFAULT 0,
  duration_ms     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_api_usage_ts ON api_usage(ts);
CREATE INDEX IF NOT EXISTS idx_api_usage_category ON api_usage(category);

-- Rollback: DROP TABLE IF EXISTS api_usage;
