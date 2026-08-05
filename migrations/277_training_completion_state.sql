-- 277: Preserve the released iOS Training completion/skip feedback contract.
--
-- Existing rows predate an explicit completion state and are therefore
-- completed by the released legacy contract. Rich health feedback stays on
-- the tenant-owned completion row; event/log surfaces carry presence only.

ALTER TABLE training_completions
  ADD COLUMN completion_state TEXT NOT NULL DEFAULT 'completed'
  CHECK (completion_state IN ('completed', 'partial', 'skipped'));

ALTER TABLE training_completions ADD COLUMN readiness_level INTEGER;
ALTER TABLE training_completions ADD COLUMN difficulty_feedback TEXT;
ALTER TABLE training_completions ADD COLUMN duration_feedback TEXT;
ALTER TABLE training_completions ADD COLUMN discomfort_flag INTEGER NOT NULL DEFAULT 0;
ALTER TABLE training_completions ADD COLUMN discomfort_flags_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE training_completions ADD COLUMN discomfort_locations_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE training_completions ADD COLUMN discomfort_details TEXT;
ALTER TABLE training_completions ADD COLUMN substitutions_used_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE training_completions ADD COLUMN felt_too_hard INTEGER NOT NULL DEFAULT 0;
ALTER TABLE training_completions ADD COLUMN felt_too_easy INTEGER NOT NULL DEFAULT 0;
ALTER TABLE training_completions ADD COLUMN felt_too_long INTEGER NOT NULL DEFAULT 0;
ALTER TABLE training_completions ADD COLUMN felt_too_short INTEGER NOT NULL DEFAULT 0;
ALTER TABLE training_completions ADD COLUMN modality TEXT;
ALTER TABLE training_completions ADD COLUMN session_role TEXT;

CREATE INDEX IF NOT EXISTS idx_training_completions_plan_state
  ON training_completions(plan_id, completion_state, completed_at);
