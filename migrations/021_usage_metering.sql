-- Migration 021: Usage metering — track AI messages per tenant per day
CREATE TABLE IF NOT EXISTS usage_metering (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL,
  date            TEXT NOT NULL,                      -- ISO date: 'YYYY-MM-DD'
  domain          TEXT NOT NULL,                      -- 'secretary' | 'triathlon' | 'content'
  message_count   INTEGER NOT NULL DEFAULT 0,
  token_count     INTEGER NOT NULL DEFAULT 0,         -- total tokens (input + output)
  cost_usd        REAL NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, date, domain)
);

CREATE INDEX IF NOT EXISTS idx_usage_metering_user_date ON usage_metering(user_id, date);
CREATE INDEX IF NOT EXISTS idx_usage_metering_date ON usage_metering(date);

-- Rollback: DROP TABLE IF EXISTS usage_metering;
