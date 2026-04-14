-- Durable per-user Garmin OAuth token storage.
--
-- The older garmin_user_tokens table mixes connection metadata
-- (email, status, last_used) with a legacy combined token blob.
-- This table becomes the durable session store the Garmin service
-- reads/writes directly so passive refreshes never depend on
-- filesystem token files.

CREATE TABLE IF NOT EXISTS garmin_sessions (
  user_id INTEGER PRIMARY KEY,
  oauth1_token_json TEXT,
  oauth2_token_json TEXT,
  last_refreshed_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_garmin_sessions_last_refreshed
  ON garmin_sessions(last_refreshed_at);
