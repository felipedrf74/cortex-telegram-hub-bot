-- 260: Aggregate-only preparation evidence for dedicated chat live evaluation.
-- The table never stores prompts, messages, provider responses, or seed text.

CREATE TABLE IF NOT EXISTS chat_live_eval_preparations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('local_engine', 'real_provider')),
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  seed_profile_version TEXT NOT NULL,
  seed_profile_hash TEXT NOT NULL,
  reset_counts_json TEXT NOT NULL,
  prepared_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (run_id, scenario_id, user_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_live_eval_preparations_run
  ON chat_live_eval_preparations(run_id, mode, user_id, tenant_id);

-- Aggregate cost evidence must exist as migration-owned schema before the
-- dashboard, digest, or baseline-acceptance services start. The production
-- migration runner PRAGMA-guards already-present ADD COLUMN statements, while
-- runtime ensureChatEvalHistoryTables retains the same protection for old
-- local databases that predate the migration ledger.
ALTER TABLE chat_eval_runs ADD COLUMN total_budget_ceiling_usd REAL;
ALTER TABLE chat_eval_runs ADD COLUMN target_budget_ceiling_usd REAL;
ALTER TABLE chat_eval_runs ADD COLUMN judge_budget_ceiling_usd REAL;
ALTER TABLE chat_eval_runs ADD COLUMN target_actual_spend_usd REAL;
ALTER TABLE chat_eval_runs ADD COLUMN judge_estimated_spend_usd REAL;
ALTER TABLE chat_eval_runs ADD COLUMN target_reserved_attempt_ceiling_usd REAL;
ALTER TABLE chat_eval_runs ADD COLUMN target_committed_ceiling_usd REAL;
ALTER TABLE chat_eval_runs ADD COLUMN total_estimated_actual_spend_usd REAL;
ALTER TABLE chat_eval_runs ADD COLUMN total_conservative_commitment_usd REAL;
ALTER TABLE chat_eval_runs ADD COLUMN target_usage_call_count INTEGER;
ALTER TABLE chat_eval_runs ADD COLUMN target_provider_attempt_count INTEGER;
ALTER TABLE chat_eval_runs ADD COLUMN cost_attestation_json TEXT;
ALTER TABLE chat_eval_runs ADD COLUMN preflight_attestation_json TEXT;

-- The first dedicated-staging real_provider run is an immutable comparison
-- identity, not a mutable "latest" pointer. Only aggregate score/cost/path
-- evidence is retained here; prompts, messages, and provider payloads remain
-- prohibited. Runtime acceptance performs the stronger attestation checks.
CREATE TABLE IF NOT EXISTS chat_eval_frozen_baselines (
  baseline_key TEXT PRIMARY KEY CHECK (baseline_key = 'first_real_provider_staging'),
  run_row_id INTEGER NOT NULL UNIQUE,
  run_id TEXT NOT NULL UNIQUE,
  accepted_at TEXT NOT NULL,
  accepted_via TEXT NOT NULL CHECK (accepted_via = 'portal_admin_token'),
  evidence_json_path TEXT NOT NULL,
  evidence_markdown_path TEXT NOT NULL,
  git_commit TEXT NOT NULL CHECK (length(git_commit) = 40),
  generated_at TEXT NOT NULL,
  scenario_set_hash TEXT NOT NULL CHECK (length(scenario_set_hash) = 64),
  eval_contract_version TEXT NOT NULL,
  seed_profile_version TEXT NOT NULL,
  average_score REAL NOT NULL,
  scenario_pass_rate REAL NOT NULL CHECK (scenario_pass_rate >= 0 AND scenario_pass_rate <= 1),
  passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
  scenario_count INTEGER NOT NULL CHECK (scenario_count > 0),
  fail_count INTEGER NOT NULL CHECK (fail_count >= 0),
  blocked_count INTEGER NOT NULL CHECK (blocked_count >= 0),
  locale_leakage_rate REAL,
  total_estimated_actual_spend_usd REAL NOT NULL CHECK (total_estimated_actual_spend_usd >= 0),
  total_budget_ceiling_usd REAL NOT NULL CHECK (total_budget_ceiling_usd >= 0),
  FOREIGN KEY (run_row_id) REFERENCES chat_eval_runs(id),
  FOREIGN KEY (run_id) REFERENCES chat_eval_runs(run_id)
);

CREATE TRIGGER IF NOT EXISTS trg_chat_eval_frozen_baseline_no_update
BEFORE UPDATE ON chat_eval_frozen_baselines
BEGIN
  SELECT RAISE(ABORT, 'frozen baseline is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_chat_eval_frozen_baseline_no_delete
BEFORE DELETE ON chat_eval_frozen_baselines
BEGIN
  SELECT RAISE(ABORT, 'frozen baseline is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_chat_eval_frozen_run_no_update
BEFORE UPDATE ON chat_eval_runs
WHEN EXISTS (SELECT 1 FROM chat_eval_frozen_baselines WHERE run_row_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'frozen baseline run is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_chat_eval_frozen_run_no_delete
BEFORE DELETE ON chat_eval_runs
WHEN EXISTS (SELECT 1 FROM chat_eval_frozen_baselines WHERE run_row_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'frozen baseline run is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_chat_eval_frozen_scenario_no_insert
BEFORE INSERT ON chat_eval_scenario_results
WHEN EXISTS (
  SELECT 1 FROM chat_eval_frozen_baselines baseline
  JOIN chat_eval_runs run ON run.id = baseline.run_row_id
  WHERE run.run_id = NEW.run_id
)
BEGIN
  SELECT RAISE(ABORT, 'frozen baseline scenario evidence is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_chat_eval_frozen_scenario_no_update
BEFORE UPDATE ON chat_eval_scenario_results
WHEN EXISTS (
  SELECT 1 FROM chat_eval_frozen_baselines baseline
  JOIN chat_eval_runs run ON run.id = baseline.run_row_id
  WHERE run.run_id = OLD.run_id OR run.run_id = NEW.run_id
)
BEGIN
  SELECT RAISE(ABORT, 'frozen baseline scenario evidence is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_chat_eval_frozen_scenario_no_delete
BEFORE DELETE ON chat_eval_scenario_results
WHEN EXISTS (
  SELECT 1 FROM chat_eval_frozen_baselines baseline
  JOIN chat_eval_runs run ON run.id = baseline.run_row_id
  WHERE run.run_id = OLD.run_id
)
BEGIN
  SELECT RAISE(ABORT, 'frozen baseline scenario evidence is immutable');
END;
