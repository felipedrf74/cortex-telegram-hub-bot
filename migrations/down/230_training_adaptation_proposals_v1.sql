-- STAGING REHEARSAL ONLY. Production rollback disables
-- TRAINING_ADAPTATION_V1_MODE and retains immutable audit history.

BEGIN TRANSACTION;

DROP VIEW IF EXISTS training_plan_adaptation_scope_v1;
DROP TRIGGER IF EXISTS trg_training_adaptation_lifecycle_events_immutable_delete;
DROP TRIGGER IF EXISTS trg_training_adaptation_lifecycle_events_immutable_update;
DROP TRIGGER IF EXISTS trg_training_adaptation_proposals_lifecycle;
DROP TRIGGER IF EXISTS trg_training_adaptation_proposals_decision_binding;
DROP TRIGGER IF EXISTS trg_training_adaptation_proposals_no_delete;
DROP TRIGGER IF EXISTS trg_training_adaptation_previews_no_delete;
DROP TRIGGER IF EXISTS trg_training_adaptation_previews_immutable_update;
DROP TRIGGER IF EXISTS trg_training_adaptation_proposals_immutable_contract;
DROP INDEX IF EXISTS idx_training_adaptation_lifecycle_scope;
DROP INDEX IF EXISTS idx_training_adaptation_proposals_material;
DROP INDEX IF EXISTS uq_training_adaptation_family_open_proposal;
DROP INDEX IF EXISTS idx_training_adaptation_proposals_source;
DROP INDEX IF EXISTS idx_training_adaptation_proposals_scope_status;
DROP INDEX IF EXISTS idx_training_adaptation_previews_scope_expiry;
DROP TABLE IF EXISTS training_adaptation_lifecycle_events;
DROP TABLE IF EXISTS training_adaptation_proposals;
DROP TABLE IF EXISTS training_adaptation_previews;
DELETE FROM _migrations WHERE filename = '230_training_adaptation_proposals_v1.sql';

COMMIT TRANSACTION;
