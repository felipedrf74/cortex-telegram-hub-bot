-- Migration 042: Add FOREIGN KEY constraints to unified_* tables
--
-- Audit Weeks 2-4 finding: migration 039 created 5 unified_* tables with
-- user_id columns but ZERO foreign key constraints. There was no
-- referential integrity at the schema level — orphaned rows from a deleted
-- user would silently linger and cross-user data could leak past WHERE
-- clause bugs in application code.
--
-- This migration uses SQLite's recommended ALTER-via-rebuild pattern
-- documented at https://www.sqlite.org/lang_altertable.html#otheralter
-- All 4 target tables have 0 rows in production at the time of this
-- migration (verified via the audit), so the data preservation cost is
-- effectively zero — but the INSERT INTO ... SELECT pattern is included
-- anyway in case a fresh dev environment has data.
--
-- Tables touched:
--   * unified_tasks            — adds FK on user_id
--   * unified_projects         — adds FK on user_id
--   * task_sync_state          — adds FK on user_id
--   * daily_context_cache      — adds FK on user_id
--
-- NOT touched:
--   * user_task_preferences    — already self-protecting (user_id is PK)
--
-- Note: PRAGMA foreign_keys must be OFF during the rebuild because the
-- new constraint would otherwise reject the data copy mid-transaction
-- (the new table's FK fires while the OLD table still has its rows).
-- We restore it to ON at the end.

PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

-- ─── unified_tasks ─────────────────────────────────────────────────────

CREATE TABLE unified_tasks_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  project_id      INTEGER,
  project_name    TEXT,
  title           TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  priority        INTEGER DEFAULT 0,
  due_date        TEXT,
  due_is_datetime INTEGER DEFAULT 0,
  tags            TEXT DEFAULT '[]',
  notes           TEXT,
  completed_at    TEXT,
  assignee        TEXT,
  url             TEXT,
  provider_data   TEXT DEFAULT '{}',
  content_hash    TEXT,
  is_deleted      INTEGER DEFAULT 0,
  synced_at       TEXT NOT NULL DEFAULT (datetime('now')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, provider, external_id)
);

INSERT INTO unified_tasks_new
SELECT id, user_id, provider, external_id, project_id, project_name,
       title, description, status, priority, due_date, due_is_datetime,
       tags, notes, completed_at, assignee, url, provider_data, content_hash,
       is_deleted, synced_at, created_at, updated_at
FROM unified_tasks;

DROP TABLE unified_tasks;
ALTER TABLE unified_tasks_new RENAME TO unified_tasks;

-- Recreate indexes (DROP not needed — they were dropped with the old table)
CREATE INDEX IF NOT EXISTS idx_unified_tasks_user_status ON unified_tasks (user_id, status, is_deleted);
CREATE INDEX IF NOT EXISTS idx_unified_tasks_user_due ON unified_tasks (user_id, due_date) WHERE is_deleted = 0;
CREATE INDEX IF NOT EXISTS idx_unified_tasks_user_provider ON unified_tasks (user_id, provider);
CREATE INDEX IF NOT EXISTS idx_unified_tasks_project ON unified_tasks (project_id);
CREATE INDEX IF NOT EXISTS idx_unified_tasks_hash ON unified_tasks (content_hash);

-- ─── unified_projects ──────────────────────────────────────────────────

CREATE TABLE unified_projects_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  name            TEXT NOT NULL,
  color           TEXT,
  is_default      INTEGER DEFAULT 0,
  task_count      INTEGER DEFAULT 0,
  synced_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, provider, external_id)
);

INSERT INTO unified_projects_new
SELECT id, user_id, provider, external_id, name, color, is_default,
       task_count, synced_at
FROM unified_projects;

DROP TABLE unified_projects;
ALTER TABLE unified_projects_new RENAME TO unified_projects;

CREATE INDEX IF NOT EXISTS idx_unified_projects_user ON unified_projects (user_id, provider);

-- ─── task_sync_state ───────────────────────────────────────────────────

CREATE TABLE task_sync_state_new (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL,
  last_sync_at     TEXT,
  sync_cursor      TEXT,
  status           TEXT DEFAULT 'idle',
  error_message    TEXT,
  tasks_synced     INTEGER DEFAULT 0,
  sync_duration_ms INTEGER,
  UNIQUE(user_id, provider)
);

INSERT INTO task_sync_state_new
SELECT id, user_id, provider, last_sync_at, sync_cursor, status,
       error_message, tasks_synced, sync_duration_ms
FROM task_sync_state;

DROP TABLE task_sync_state;
ALTER TABLE task_sync_state_new RENAME TO task_sync_state;

CREATE INDEX IF NOT EXISTS idx_task_sync_state_user ON task_sync_state (user_id);

-- ─── daily_context_cache ───────────────────────────────────────────────

CREATE TABLE daily_context_cache_new (
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date            TEXT NOT NULL,
  context_summary TEXT NOT NULL,
  built_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, date)
);

INSERT INTO daily_context_cache_new
SELECT user_id, date, context_summary, built_at
FROM daily_context_cache;

DROP TABLE daily_context_cache;
ALTER TABLE daily_context_cache_new RENAME TO daily_context_cache;

CREATE INDEX IF NOT EXISTS idx_daily_context_built_at ON daily_context_cache (built_at);

COMMIT;

PRAGMA foreign_keys = ON;
