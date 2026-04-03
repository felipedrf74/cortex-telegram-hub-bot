-- Migration 031: Per-user OAuth token storage for Google + Outlook integrations

CREATE TABLE IF NOT EXISTS user_oauth_tokens (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL,
  provider        TEXT NOT NULL,
  access_token    TEXT NOT NULL,
  refresh_token   TEXT NOT NULL,
  token_type      TEXT NOT NULL DEFAULT 'Bearer',
  expires_at      TEXT,
  scopes          TEXT,
  raw_response    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_oauth_user ON user_oauth_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_provider ON user_oauth_tokens (user_id, provider);

-- Rollback: DROP TABLE IF EXISTS user_oauth_tokens;
