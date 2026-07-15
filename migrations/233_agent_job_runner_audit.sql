-- Migration 233: durable governance ledger for shared scheduled-agent runs.
--
-- The ledger stores only opaque fingerprints, bounded status/error codes, and
-- provider usage totals. It deliberately never stores prompts, provider
-- responses, calendar content, or other tenant data. Provider-capable jobs
-- fail closed before execution when this table or api_usage attribution is
-- unavailable.
CREATE TABLE IF NOT EXISTS agent_job_runs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                TEXT NOT NULL UNIQUE,
  job_id                TEXT NOT NULL,
  job_version           TEXT NOT NULL,
  tenant_id             INTEGER NOT NULL,
  user_id               INTEGER NOT NULL,
  attempt               INTEGER NOT NULL CHECK (attempt > 0),
  status                TEXT NOT NULL CHECK (status IN (
                          'running',
                          'success',
                          'skipped_unchanged',
                          'skipped_no_work',
                          'skipped_overlap',
                          'failed'
                        )),
  input_fingerprint     TEXT,
  output_fingerprint    TEXT,
  skip_reason           TEXT,
  error_code            TEXT,
  provider_calls        INTEGER NOT NULL DEFAULT 0 CHECK (provider_calls >= 0),
  cost_usd              REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  duration_ms           INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  notification_status   TEXT NOT NULL DEFAULT 'not_applicable' CHECK (
                          notification_status IN ('not_applicable', 'pending', 'sent', 'failed')
                        ),
  started_at            TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at          TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_job_runs_scope_started
  ON agent_job_runs(job_id, tenant_id, user_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_job_runs_fingerprint
  ON agent_job_runs(job_id, job_version, tenant_id, user_id, input_fingerprint, status)
  WHERE input_fingerprint IS NOT NULL;
