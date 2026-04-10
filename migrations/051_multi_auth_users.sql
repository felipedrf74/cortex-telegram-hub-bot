-- 051_multi_auth_users.sql — Multi-provider authentication
--
-- Evolves the users table to support Sign in with Apple, Google,
-- and Email/Password alongside the existing Telegram-based auth.
--
-- CRITICAL: SQLite cannot ALTER column constraints, so we rebuild
-- the table. All existing data is preserved with auth_provider='telegram'.

-- Step 1: Create the new schema
CREATE TABLE IF NOT EXISTS users_new (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id           INTEGER UNIQUE,                        -- NULLABLE now (was NOT NULL)
  email                 TEXT UNIQUE,                            -- for email+password auth
  password_hash         TEXT,                                   -- bcrypt, NULL for social logins
  apple_user_id         TEXT UNIQUE,                            -- Apple Identity Token 'sub'
  google_user_id        TEXT UNIQUE,                            -- Google ID Token 'sub'
  email_verified        INTEGER NOT NULL DEFAULT 0,             -- 1 for Apple/Google (pre-verified)
  username              TEXT,
  first_name            TEXT,
  last_name             TEXT,
  avatar_url            TEXT,
  language              TEXT NOT NULL DEFAULT 'pt-BR',
  timezone              TEXT NOT NULL DEFAULT 'Europe/Lisbon',
  tier                  TEXT NOT NULL DEFAULT 'free',           -- free, pro, max, owner
  status                TEXT NOT NULL DEFAULT 'active',         -- active, suspended, banned
  auth_provider         TEXT NOT NULL DEFAULT 'telegram',       -- telegram, apple, google, email
  invite_code           TEXT,
  daily_message_limit   INTEGER NOT NULL DEFAULT 40,
  daily_token_limit     INTEGER NOT NULL DEFAULT 100000,
  daily_cost_limit_usd  REAL NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  last_active_at        TEXT
);

-- Step 2: Copy existing Telegram users (preserve all data + IDs)
INSERT OR IGNORE INTO users_new (
  id, telegram_id, username, first_name, last_name,
  language, timezone, tier, status, auth_provider, invite_code,
  daily_message_limit, daily_token_limit, daily_cost_limit_usd,
  created_at, last_active_at
)
SELECT
  id, telegram_id, username, first_name, last_name,
  language, timezone, tier, status, 'telegram', invite_code,
  daily_message_limit, daily_token_limit, daily_cost_limit_usd,
  created_at, last_active_at
FROM users;

-- Step 3: Swap tables
DROP TABLE IF EXISTS users;
ALTER TABLE users_new RENAME TO users;

-- Step 4: Rebuild indexes
CREATE INDEX IF NOT EXISTS idx_users_telegram ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_apple ON users(apple_user_id);
CREATE INDEX IF NOT EXISTS idx_users_google ON users(google_user_id);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_tier ON users(tier);
