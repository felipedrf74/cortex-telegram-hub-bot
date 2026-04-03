-- Migration 030: User registration and invite codes for multi-user support

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id     INTEGER NOT NULL UNIQUE,
  username        TEXT,
  first_name      TEXT,
  last_name       TEXT,
  language        TEXT NOT NULL DEFAULT 'pt-BR',
  timezone        TEXT NOT NULL DEFAULT 'Europe/Lisbon',
  tier            TEXT NOT NULL DEFAULT 'free',
  status          TEXT NOT NULL DEFAULT 'active',
  invite_code     TEXT,
  daily_message_limit   INTEGER NOT NULL DEFAULT 40,
  daily_token_limit     INTEGER NOT NULL DEFAULT 100000,
  daily_cost_limit_usd  REAL NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_active_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_telegram ON users (telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_status ON users (status);
CREATE INDEX IF NOT EXISTS idx_users_tier ON users (tier);

CREATE TABLE IF NOT EXISTS invite_codes (
  code            TEXT PRIMARY KEY,
  created_by      INTEGER,
  max_uses        INTEGER NOT NULL DEFAULT 1,
  used_count      INTEGER NOT NULL DEFAULT 0,
  expires_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Rollback: DROP TABLE IF EXISTS invite_codes; DROP TABLE IF EXISTS users;
