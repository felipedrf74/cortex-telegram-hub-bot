-- Rollback for migration 233.
DROP INDEX IF EXISTS idx_agent_job_runs_fingerprint;
DROP INDEX IF EXISTS idx_agent_job_runs_scope_started;
DROP TABLE IF EXISTS agent_job_runs;
