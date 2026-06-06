-- Home orchestration + provider preference support.
-- All tables are user/tenant scoped; no provider/auth truth is stored here.

CREATE TABLE IF NOT EXISTS user_provider_preferences (
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  primary_mail_provider TEXT NOT NULL DEFAULT 'auto'
    CHECK (primary_mail_provider IN ('auto', 'gmail', 'outlook')),
  primary_calendar_provider TEXT NOT NULL DEFAULT 'auto'
    CHECK (primary_calendar_provider IN ('auto', 'google', 'outlook')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_user_provider_preferences_scope
  ON user_provider_preferences(user_id, tenant_id);

CREATE TABLE IF NOT EXISTS decision_queue_daily_rollups (
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  local_date TEXT NOT NULL,
  timezone TEXT NOT NULL,
  reached_zero_at TEXT,
  final_open_count INTEGER NOT NULL DEFAULT 0,
  best_observed_open_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, tenant_id, local_date)
);

CREATE INDEX IF NOT EXISTS idx_decision_queue_daily_rollups_scope_date
  ON decision_queue_daily_rollups(user_id, tenant_id, local_date DESC);
