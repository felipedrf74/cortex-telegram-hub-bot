-- 053_native_tasks.sql — Native task system (no external provider)
--
-- For users who don't use Microsoft To-Do or Todoist.
-- Full task management stored in our SQLite DB.
-- Same data model as the unified task store's NormalizedTask.

CREATE TABLE IF NOT EXISTS native_task_lists (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  name        TEXT NOT NULL,
  is_default  INTEGER NOT NULL DEFAULT 0,
  color       TEXT,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_native_lists_user ON native_task_lists(user_id);

CREATE TABLE IF NOT EXISTS native_tasks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL,
  list_id         INTEGER NOT NULL REFERENCES native_task_lists(id),
  title           TEXT NOT NULL,
  body            TEXT,
  importance      TEXT NOT NULL DEFAULT 'normal',    -- low, normal, high
  status          TEXT NOT NULL DEFAULT 'notStarted', -- notStarted, inProgress, completed
  due_date_time   TEXT,                               -- ISO 8601
  reminder_date   TEXT,
  recurrence      TEXT,                               -- JSON recurrence pattern
  tags            TEXT,                                -- JSON array of tags
  position        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_native_tasks_user ON native_tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_native_tasks_list ON native_tasks(list_id);
CREATE INDEX IF NOT EXISTS idx_native_tasks_status ON native_tasks(user_id, status);
CREATE INDEX IF NOT EXISTS idx_native_tasks_due ON native_tasks(user_id, due_date_time);

-- Seed a default "Inbox" list for each existing user
-- New users get their default list created during onboarding
INSERT OR IGNORE INTO native_task_lists (user_id, name, is_default)
SELECT id, 'Inbox', 1 FROM users WHERE auth_provider != 'telegram';
