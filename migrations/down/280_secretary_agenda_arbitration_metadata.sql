-- Roll back only migration 280's inert arbitration metadata prerequisite.
-- Cross-skill priority preemption is not enabled by this migration.

DROP INDEX IF EXISTS idx_secretary_agenda_arbitration_scope;
ALTER TABLE secretary_agenda_items DROP COLUMN arbitration_policy_version;
ALTER TABLE secretary_agenda_items DROP COLUMN arbitration_flexibility;
ALTER TABLE secretary_agenda_items DROP COLUMN arbitration_deadline_at;
ALTER TABLE secretary_agenda_items DROP COLUMN arbitration_score;
