-- Migration 039: Unified task store for multi-provider task aggregation
--
-- Implements TASK-16a — the foundation of the cross-provider task & calendar
-- aggregator. External providers (MS To Do, Todoist, Notion, etc.) remain the
-- source of truth for DATA. The unified store is the source of truth for AI
-- READS — every AI call hits this table, never the provider APIs directly.
--
-- Five tables:
--   1. unified_tasks            — normalized task rows from every provider
--   2. unified_projects         — normalized project/list rows
--   3. task_sync_state          — per-provider sync cursor + status per user
--   4. user_task_preferences    — default provider, sync enabled flag
--   5. daily_context_cache      — pre-built cross-domain summary (~500 tokens)

-- ─── unified_tasks ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS unified_tasks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL,
  provider        TEXT NOT NULL,                    -- 'ms_todo' | 'todoist' | 'notion' | 'nexus'
  external_id     TEXT NOT NULL,                    -- Provider-specific task ID
  project_id      INTEGER,                          -- FK to unified_projects (optional)
  project_name    TEXT,                             -- Denormalized for fast reads
  title           TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'completed' | 'in_progress' | 'cancelled'
  priority        INTEGER DEFAULT 0,                -- 0=none, 1=low, 2=medium, 3=high, 4=urgent
  due_date        TEXT,                             -- ISO 8601 date or datetime
  due_is_datetime INTEGER DEFAULT 0,                -- 1 if dueDate has time component
  tags            TEXT DEFAULT '[]',                -- JSON array
  notes           TEXT,
  completed_at    TEXT,
  assignee        TEXT,                             -- For shared projects
  url             TEXT,                             -- Deep link to task in provider app
  provider_data   TEXT DEFAULT '{}',                -- Full provider JSON (for fields we don't normalize)
  content_hash    TEXT,                             -- SHA256 of key fields for change detection
  is_deleted      INTEGER DEFAULT 0,                -- Soft delete (task removed from provider)
  synced_at       TEXT NOT NULL DEFAULT (datetime('now')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, provider, external_id)
);

-- Hot-path indexes:
--   * status filter — 'show me pending tasks' is the #1 query
--   * due-date range scans — for 'overdue' / 'due today' / 'due this week'
--   * provider scope — for 'sync all Todoist tasks for user X'
--   * project scope — for 'show all tasks in this project'
--   * content hash — for 'has this task actually changed?' lookups
CREATE INDEX IF NOT EXISTS idx_unified_tasks_user_status ON unified_tasks (user_id, status, is_deleted);
CREATE INDEX IF NOT EXISTS idx_unified_tasks_user_due ON unified_tasks (user_id, due_date) WHERE is_deleted = 0;
CREATE INDEX IF NOT EXISTS idx_unified_tasks_user_provider ON unified_tasks (user_id, provider);
CREATE INDEX IF NOT EXISTS idx_unified_tasks_project ON unified_tasks (project_id);
CREATE INDEX IF NOT EXISTS idx_unified_tasks_hash ON unified_tasks (content_hash);

-- ─── unified_projects ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS unified_projects (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL,
  provider        TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  name            TEXT NOT NULL,
  color           TEXT,                             -- Hex color from provider
  is_default      INTEGER DEFAULT 0,                -- User's default inbox/project
  task_count      INTEGER DEFAULT 0,
  synced_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, provider, external_id)
);

CREATE INDEX IF NOT EXISTS idx_unified_projects_user ON unified_projects (user_id, provider);

-- ─── task_sync_state ───────────────────────────────────────────────────
-- One row per (user, provider). Tracks the incremental sync cursor and the
-- last sync attempt's outcome so the sync engine can resume cleanly after
-- a restart and the portal can show "Last synced: 3 min ago" indicators.
CREATE TABLE IF NOT EXISTS task_sync_state (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL,
  provider         TEXT NOT NULL,
  last_sync_at     TEXT,
  sync_cursor      TEXT,                            -- Provider-specific cursor/token
  status           TEXT DEFAULT 'idle',             -- 'idle' | 'syncing' | 'error'
  error_message    TEXT,
  tasks_synced     INTEGER DEFAULT 0,
  sync_duration_ms INTEGER,
  UNIQUE(user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_task_sync_state_user ON task_sync_state (user_id);

-- ─── user_task_preferences ─────────────────────────────────────────────
-- Per-user routing config: which provider new tasks are written to, which
-- provider is the dedup source-of-truth when the same task exists in two
-- places, and a kill-switch for the entire sync engine.
CREATE TABLE IF NOT EXISTS user_task_preferences (
  user_id          INTEGER PRIMARY KEY,
  default_provider TEXT NOT NULL DEFAULT 'nexus',   -- Where new tasks go on `createTask`
  primary_provider TEXT,                            -- Source of truth for dedup
  sync_enabled     INTEGER DEFAULT 1,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── daily_context_cache ───────────────────────────────────────────────
-- Pre-built ~500-token summary covering tasks + calendar + training +
-- readiness + content pipeline. Built fresh at 5 AM and on-demand whenever
-- a write invalidates it. Injected into every AI call as system context to
-- avoid 1300+ tokens of speculative tool calls per message.
CREATE TABLE IF NOT EXISTS daily_context_cache (
  user_id         INTEGER NOT NULL,
  date            TEXT NOT NULL,                    -- ISO date (YYYY-MM-DD)
  context_summary TEXT NOT NULL,
  built_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_daily_context_built_at ON daily_context_cache (built_at);
