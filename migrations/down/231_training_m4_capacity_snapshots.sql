-- STAGING REHEARSAL ONLY. Production rollback disables scoped Training M4
-- flags and retains snapshots unless this explicit inverse is rehearsed.

BEGIN TRANSACTION;

DROP TRIGGER IF EXISTS trg_training_m4_capacity_snapshots_immutable_delete;
DROP TRIGGER IF EXISTS trg_training_m4_capacity_snapshots_immutable_update;
DROP INDEX IF EXISTS idx_training_m4_capacity_scope_freshness;
DROP TABLE IF EXISTS training_m4_capacity_prune_authorizations;
DROP TABLE IF EXISTS training_m4_capacity_snapshots;
DELETE FROM _migrations WHERE filename = '231_training_m4_capacity_snapshots.sql';

COMMIT TRANSACTION;
