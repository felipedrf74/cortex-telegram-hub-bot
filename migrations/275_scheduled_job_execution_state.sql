-- 275: Durable leases and success checkpoints for deterministic scheduled jobs.
--
-- This store contains operational metadata only. It never stores provider
-- payloads, prompts, calendar content, or user-authentication material.

CREATE TABLE IF NOT EXISTS scheduled_job_execution_state (
  job_name TEXT NOT NULL CHECK (length(job_name) BETWEEN 1 AND 120),
  scope_key TEXT NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 240),
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  last_started_at TEXT,
  last_completed_at TEXT,
  last_succeeded_at TEXT,
  last_result TEXT CHECK (last_result IS NULL OR last_result IN ('success', 'skipped', 'failed')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (job_name, scope_key),
  CHECK (
    (lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
    OR
    (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_scheduled_job_execution_active_lease
  ON scheduled_job_execution_state(lease_expires_at)
  WHERE lease_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_scheduled_job_execution_checkpoint
  ON scheduled_job_execution_state(job_name, last_succeeded_at);
