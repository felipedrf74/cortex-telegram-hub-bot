-- Per-user Garmin token storage.
-- Replaces the filesystem-based token storage in data/garmin-tokens/
-- with DB-backed per-user tokens, enabling multi-user Garmin support.
--
-- The garth library's tokens are JSON blobs (OAuth1 + OAuth2 tokens).
-- We store them as-is so we can export/import to/from the garth library
-- without transformation.

CREATE TABLE IF NOT EXISTS garmin_user_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  garmin_email TEXT,
  tokens_json TEXT NOT NULL,       -- garth library token export (JSON blob)
  last_refresh TEXT DEFAULT (datetime('now')),
  last_used TEXT DEFAULT (datetime('now')),
  status TEXT DEFAULT 'active',    -- 'active', 'expired', 'mfa_pending'
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_garmin_tokens_user ON garmin_user_tokens(user_id);
