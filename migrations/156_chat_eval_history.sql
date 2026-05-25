-- Chat evaluation history for nightly live/fixture runs.
-- Stores aggregate scores and per-scenario metadata only; raw chat turns and
-- provider payloads must remain in short-lived artifacts, not the DB.

CREATE TABLE IF NOT EXISTS chat_eval_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('fixture', 'local_engine', 'real_provider')),
  generated_at TEXT NOT NULL,
  package_version TEXT,
  git_branch TEXT,
  git_commit TEXT,
  average_score REAL NOT NULL,
  scenario_count INTEGER NOT NULL,
  pass_count INTEGER NOT NULL,
  partial_count INTEGER NOT NULL,
  fail_count INTEGER NOT NULL,
  blocked_count INTEGER NOT NULL,
  passed INTEGER NOT NULL DEFAULT 0,
  production_data_used INTEGER NOT NULL DEFAULT 0,
  real_provider_calls INTEGER NOT NULL DEFAULT 0,
  budget_usd REAL,
  json_report_path TEXT,
  markdown_report_path TEXT,
  quality_metrics_json TEXT NOT NULL DEFAULT '[]',
  day_to_day_summary_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_eval_scenario_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pass', 'partial', 'fail', 'blocked')),
  evidence_mode TEXT NOT NULL,
  average_score REAL NOT NULL,
  failures_json TEXT NOT NULL DEFAULT '[]',
  notes_json TEXT NOT NULL DEFAULT '[]',
  scores_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_id, scenario_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_eval_runs_generated_at
  ON chat_eval_runs(generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_eval_runs_mode_passed
  ON chat_eval_runs(mode, passed, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_eval_scenario_results_run
  ON chat_eval_scenario_results(run_id, scenario_id, persona_id);
