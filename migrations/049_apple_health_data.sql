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
