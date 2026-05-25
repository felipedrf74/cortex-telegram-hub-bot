-- 161: Travel windows (slice C2) + per-week equipment override (slice C3).
--
-- Per the Week-Level Adaptability + Periodization plan (v2.1).
--
-- C2: travel_windows table. iOS POSTs a window when the user is
--     about to travel; the planner consumes it as a soft signal
--     that modulates equipment availability, session duration, and
--     reduces hard-intensity expectations during the window.
--
-- C3: equipment_override_json column on training_weeks. When set,
--     overrides the athlete's standing equipmentAccess for that
--     week only — useful for travel weeks, gym closures, etc.

CREATE TABLE IF NOT EXISTS travel_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  equipment_profile TEXT,
  time_zone_shift_hours INTEGER,
  flight_duration_hours INTEGER,
  sleep_disruption_expected INTEGER NOT NULL DEFAULT 0,
  walking_load_expected INTEGER NOT NULL DEFAULT 0,
  heat_stress INTEGER NOT NULL DEFAULT 0,
  available_session_duration_minutes INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_travel_windows_user_dates
  ON travel_windows(user_id, start_date, end_date);

ALTER TABLE training_weeks
  ADD COLUMN equipment_override_json TEXT;
