-- iOS device registration table
-- Stores JWT refresh tokens and APNs push tokens per device
CREATE TABLE IF NOT EXISTS ios_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  device_id TEXT NOT NULL UNIQUE,
  device_name TEXT,
  push_token TEXT,
  refresh_token TEXT NOT NULL,
  last_active_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ios_devices_user ON ios_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_ios_devices_refresh ON ios_devices(refresh_token);
