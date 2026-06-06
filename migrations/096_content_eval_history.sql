-- Migration 096: Content Creation evaluation run history.
--
-- Stores normalized release/evaluation evidence without raw transcripts,
-- prompts, references, drafts, scripts, or provider outputs. Detailed reports
-- stay in local Markdown/JSON artifacts; this table keeps queryable release
-- gate metadata for support, release review, and trend tracking.

CREATE TABLE IF NOT EXISTS content_eval_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL UNIQUE,
  skill_id TEXT NOT NULL DEFAULT 'content',
  skill_version TEXT,
  mode TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  package_version TEXT,
  git_branch TEXT,
  git_commit TEXT,
  overall_score INTEGER NOT NULL,
  min_score INTEGER NOT NULL,
  case_count INTEGER NOT NULL,
  pass_count INTEGER NOT NULL,
  partial_count INTEGER NOT NULL,
  fail_count INTEGER NOT NULL,
  critical_failure_count INTEGER NOT NULL,
  release_gate TEXT NOT NULL,
  passed INTEGER NOT NULL,
  production_data_used INTEGER NOT NULL DEFAULT 0,
  real_provider_calls INTEGER NOT NULL DEFAULT 0,
  provider TEXT,
  model TEXT,
  tier TEXT,
  category TEXT,
  fallback_used INTEGER NOT NULL DEFAULT 0,
  json_report_path TEXT,
  markdown_report_path TEXT,
  open_conditions_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS content_eval_case_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  status TEXT NOT NULL,
  score INTEGER NOT NULL,
  failures_json TEXT NOT NULL DEFAULT '[]',
  dimension_scores_json TEXT NOT NULL DEFAULT '{}',
  provider_trace_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_id, case_id)
);

CREATE INDEX IF NOT EXISTS idx_content_eval_runs_generated_at
  ON content_eval_runs(generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_eval_runs_gate
  ON content_eval_runs(skill_id, release_gate, mode);
CREATE INDEX IF NOT EXISTS idx_content_eval_case_results_run
  ON content_eval_case_results(run_id, scenario_id, persona_id);
