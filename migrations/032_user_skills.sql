-- Migration 032: Per-user skill overrides for admin-controlled access
-- Only stores DISABLED skills — if no row exists, skill is ENABLED (default).

CREATE TABLE IF NOT EXISTS user_skill_overrides (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL,
  skill           TEXT NOT NULL,
  sub_skill       TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  reason          TEXT,
  updated_by      INTEGER,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, skill, sub_skill)
);

CREATE INDEX IF NOT EXISTS idx_user_skills ON user_skill_overrides (user_id, skill);

-- Rollback: DROP TABLE IF EXISTS user_skill_overrides;
