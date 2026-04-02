-- Usage metering: per-user per-day AI usage aggregation
-- Supports quota enforcement and historical usage reporting

CREATE TABLE IF NOT EXISTS usage_metering (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL,
  date            TEXT    NOT NULL,  -- ISO date 'YYYY-MM-DD'
  message_count   INTEGER NOT NULL DEFAULT 0,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  total_tokens    INTEGER NOT NULL DEFAULT 0,
  api_calls       INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL    NOT NULL DEFAULT 0,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_metering_user_date
  ON usage_metering(user_id, date);

CREATE INDEX IF NOT EXISTS idx_usage_metering_date
  ON usage_metering(date);

-- Usage quotas: configurable per-user daily limits
CREATE TABLE IF NOT EXISTS usage_quotas (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id               INTEGER NOT NULL UNIQUE,
  daily_message_limit   INTEGER,          -- NULL = unlimited
  daily_token_limit     INTEGER,          -- NULL = unlimited
  daily_cost_limit_usd  REAL,             -- NULL = unlimited
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
