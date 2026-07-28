DROP TRIGGER IF EXISTS trg_chat_eval_frozen_scenario_no_delete;
DROP TRIGGER IF EXISTS trg_chat_eval_frozen_scenario_no_update;
DROP TRIGGER IF EXISTS trg_chat_eval_frozen_scenario_no_insert;
DROP TRIGGER IF EXISTS trg_chat_eval_frozen_run_no_delete;
DROP TRIGGER IF EXISTS trg_chat_eval_frozen_run_no_update;
DROP TRIGGER IF EXISTS trg_chat_eval_frozen_baseline_no_delete;
DROP TRIGGER IF EXISTS trg_chat_eval_frozen_baseline_no_update;
DROP TABLE IF EXISTS chat_eval_frozen_baselines;
DROP INDEX IF EXISTS idx_chat_live_eval_preparations_run;
DROP TABLE IF EXISTS chat_live_eval_preparations;

-- The nullable aggregate cost-evidence columns on chat_eval_runs are retained
-- on rollback. Removing columns requires a table rebuild on older SQLite and
-- would risk unrelated historical eval rows; pre-260 code safely ignores them.
