-- Rollback for migration 276. Dropping the logical-state index restores the
-- legacy per-agenda-item uniqueness; agenda_version is then removable.
DROP INDEX IF EXISTS idx_training_feedback_decisions_scope_version;
DROP INDEX IF EXISTS idx_training_feedback_decisions_current_intent;
ALTER TABLE training_feedback_decisions DROP COLUMN agenda_version;
