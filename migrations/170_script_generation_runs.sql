-- Migration 170: script_generation_runs
--
-- Persistence for the local script-generation pipeline run records.
-- One row per script-generation invocation captures the model, token
-- counts, validation outcome, and per-run metadata so we can audit local
-- model quality in Phase 3 (real-traffic evaluation).
--
-- See WO-ollama-local-llm and plan Revision 4 items 11–13.
--
-- v2.6 (angry-QA-found): CREATE TABLE IF NOT EXISTS is a no-op if the
-- table already exists with a different (incompatible) schema. SQLite
-- offers no portable "ASSERT column exists" inside a migration script,
-- so the application-level guard in `script-generation.ts`
-- `assertScriptGenerationRunsSchema()` runs on first use and refuses to
-- insert if any required column is missing. If you're applying this
-- migration on a DB that has a legacy `script_generation_runs` table
-- with the wrong shape, drop that table first (or run a manual ALTER
-- TABLE) and re-apply.

CREATE TABLE IF NOT EXISTS script_generation_runs (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                          INTEGER NOT NULL,                  -- unix seconds
  user_id                     INTEGER,
  tenant_id                   INTEGER,
  provider                    TEXT NOT NULL,
  model                       TEXT NOT NULL,
  model_digest                TEXT,
  task_label                  TEXT,
  prompt_tokens               INTEGER,
  completion_tokens           INTEGER,
  duration_ms                 INTEGER,
  load_duration_ms            INTEGER,
  validation_status           TEXT NOT NULL,                     -- 'passed' | 'failed' | 'skipped'
  fallback_used               INTEGER NOT NULL DEFAULT 0,        -- 0/1
  requires_cloud_reasoning    INTEGER NOT NULL DEFAULT 0,        -- 0/1
  requires_human_approval     INTEGER NOT NULL DEFAULT 0,        -- 0/1
  risk_level                  TEXT,                              -- 'low' | 'medium' | 'high'
  artifact_count              INTEGER NOT NULL DEFAULT 0,
  meta_json                   TEXT
);

CREATE INDEX IF NOT EXISTS idx_sgr_ts          ON script_generation_runs (ts);
CREATE INDEX IF NOT EXISTS idx_sgr_user        ON script_generation_runs (user_id, ts);
CREATE INDEX IF NOT EXISTS idx_sgr_status      ON script_generation_runs (validation_status, ts);

-- Rollback: DROP TABLE IF EXISTS script_generation_runs;
