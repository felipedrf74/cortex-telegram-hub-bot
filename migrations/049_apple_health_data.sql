-- ⚠️ SCHEMA DRIFT WARNING (2026-04-20 hardening audit):
--
-- This migration defines a table `apple_health_data` that is ALSO
-- defined with a DIFFERENT schema in migrations/035_apple_health_data.sql.
-- Because both use `CREATE TABLE IF NOT EXISTS`, the one applied FIRST
-- wins. Migration runner sort order is alphabetical by filename, so 035
-- always runs before 049 on a fresh DB — meaning this file's schema is
-- effectively DEAD on any deployment that started from scratch after
-- 2026 (prod included).
--
-- Drifted columns:
--   035 has `source_name` + `created_at`        (prod schema)
--   049 has `source`      + `synced_at`         (never applied)
-- Drifted uniqueness:
--   035 UNIQUE(user_id, data_type, date, source_name)
--   049 UNIQUE(user_id, date, data_type)
--
-- `src/api/routes/health-data.ts:73-95` reflects on PRAGMA table_info
-- at runtime and picks whichever column exists — so production is not
-- broken, but the cost of this kludge is a forever "which schema are
-- we actually on?" drag.
--
-- DO NOT rename or delete this file — it's already recorded in the
-- `_migrations` table on every environment. If you need to add columns,
-- create a NEW migration (e.g. 060_apple_health_data_columns.sql) that
-- uses ALTER TABLE and targets the 035 shape.
--
-- Apple Health data sync table — receives daily health snapshots from the
-- iOS app via POST /api/v1/health-data/sync. The AppleHealthAdapter
-- (src/services/wearable/apple-health-adapter.ts) already queries this
-- table; it just needed data to exist.
--
-- One row per user per date per data_type. The iOS app calls the sync
-- endpoint once per day on app launch (or via background refresh), sending
-- a HealthDaySnapshot that gets decomposed into multiple rows here.

CREATE TABLE IF NOT EXISTS apple_health_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,           -- YYYY-MM-DD
  data_type TEXT NOT NULL,      -- 'hrv', 'resting_hr', 'sleep', 'steps', 'calories', 'vo2max', 'workouts'
  data_json TEXT NOT NULL,      -- JSON payload specific to each data_type
  source TEXT DEFAULT 'ios_app', -- 'ios_app', 'manual', 'background_sync'
  synced_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, date, data_type)
);

CREATE INDEX IF NOT EXISTS idx_apple_health_user_date ON apple_health_data(user_id, date);
CREATE INDEX IF NOT EXISTS idx_apple_health_type ON apple_health_data(data_type, date);
