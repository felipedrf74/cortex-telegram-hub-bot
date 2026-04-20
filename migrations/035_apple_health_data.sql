-- ⚠️ SCHEMA DRIFT WARNING (2026-04-20 hardening audit):
-- This is the AUTHORITATIVE `apple_health_data` schema. A drifted
-- duplicate lives at migrations/049_apple_health_data.sql — see the
-- header of that file for details. Any ALTER TABLE work should target
-- THIS shape (`source_name` + `created_at`).
CREATE TABLE IF NOT EXISTS apple_health_data (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  data_type   TEXT NOT NULL,
  date        TEXT NOT NULL,
  data_json   TEXT NOT NULL,
  source_name TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, data_type, date, source_name)
);
CREATE INDEX IF NOT EXISTS idx_apple_health_user_type ON apple_health_data (user_id, data_type, date);
