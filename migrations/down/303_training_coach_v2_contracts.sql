-- Reverse migration 303. All added tables are dormant contract stores and
-- all added columns are additive, so SQLite DROP COLUMN is safe after the
-- dependent indexes/tables are removed in reverse dependency order.

DROP TABLE IF EXISTS training_health_safety_state;
DROP TABLE IF EXISTS health_data_mutation_receipts;
DROP TABLE IF EXISTS athlete_health_signal_corrections;
DROP TABLE IF EXISTS health_data_consent_revisions;
DROP TABLE IF EXISTS training_coach_v2_proposals;
DROP TABLE IF EXISTS training_coach_v2_reflow_previews;
DROP TABLE IF EXISTS travel_window_mutation_receipts;

DROP INDEX IF EXISTS idx_health_signals_expiry;
DROP INDEX IF EXISTS uq_athlete_health_signals_scope_id;
DROP INDEX IF EXISTS uq_athlete_health_signal_scope_idempotency;
DROP INDEX IF EXISTS uq_fitness_training_plans_scope_id;
DROP INDEX IF EXISTS uq_training_weeks_plan_id;
DROP INDEX IF EXISTS uq_travel_windows_scope_idempotency;

ALTER TABLE athlete_health_signals DROP COLUMN request_hash;
ALTER TABLE athlete_health_signals DROP COLUMN idempotency_key;
ALTER TABLE athlete_health_signals DROP COLUMN expires_at;

ALTER TABLE fitness_training_plans DROP COLUMN coach_plan_policy_version;

ALTER TABLE travel_windows DROP COLUMN request_hash;
ALTER TABLE travel_windows DROP COLUMN idempotency_key;
ALTER TABLE travel_windows DROP COLUMN updated_at;
ALTER TABLE travel_windows DROP COLUMN version;
