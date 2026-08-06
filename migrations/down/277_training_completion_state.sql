DROP INDEX IF EXISTS idx_training_completions_plan_state;

ALTER TABLE training_completions DROP COLUMN session_role;
ALTER TABLE training_completions DROP COLUMN modality;
ALTER TABLE training_completions DROP COLUMN felt_too_short;
ALTER TABLE training_completions DROP COLUMN felt_too_long;
ALTER TABLE training_completions DROP COLUMN felt_too_easy;
ALTER TABLE training_completions DROP COLUMN felt_too_hard;
ALTER TABLE training_completions DROP COLUMN substitutions_used_json;
ALTER TABLE training_completions DROP COLUMN discomfort_details;
ALTER TABLE training_completions DROP COLUMN discomfort_locations_json;
ALTER TABLE training_completions DROP COLUMN discomfort_flags_json;
ALTER TABLE training_completions DROP COLUMN discomfort_flag;
ALTER TABLE training_completions DROP COLUMN duration_feedback;
ALTER TABLE training_completions DROP COLUMN difficulty_feedback;
ALTER TABLE training_completions DROP COLUMN readiness_level;
ALTER TABLE training_completions DROP COLUMN completion_state;
