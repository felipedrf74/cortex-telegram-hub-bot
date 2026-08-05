-- Rollback for migration 275.
DROP INDEX IF EXISTS idx_scheduled_job_execution_checkpoint;
DROP INDEX IF EXISTS idx_scheduled_job_execution_active_lease;
DROP TABLE IF EXISTS scheduled_job_execution_state;
