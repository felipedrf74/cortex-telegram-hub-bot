-- 295: durable OpenAI Batch transport for scheduled Content script stages.
--
-- Every external batch is bound to one tenant-owned script job and one exact
-- request digest. Provider identifiers are operational metadata only; prompt
-- and result bytes remain in the existing encrypted job/checkpoint columns.

CREATE TABLE content_script_provider_batches (
  job_id TEXT NOT NULL,
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  owner_user_id INTEGER NOT NULL CHECK (owner_user_id > 0),
  stage_key TEXT NOT NULL CHECK (length(stage_key) = 64 AND stage_key NOT GLOB '*[^0-9a-f]*'),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  provider TEXT NOT NULL DEFAULT 'openai' CHECK (provider = 'openai'),
  custom_id TEXT NOT NULL CHECK (length(trim(custom_id)) > 0),
  input_file_id TEXT,
  provider_batch_id TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'preparing', 'submitted', 'validating', 'in_progress', 'finalizing',
    'completed', 'cancellation_requested', 'cancelling', 'cancelled',
    'failed', 'expired'
  )),
  output_file_id TEXT,
  error_file_id TEXT,
  last_error_code TEXT,
  submitted_at TEXT,
  completed_at TEXT,
  provider_files_deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (job_id, stage_key),
  UNIQUE(provider_batch_id),
  CHECK (provider_batch_id IS NULL OR input_file_id IS NOT NULL),
  CHECK (status NOT IN ('submitted', 'validating', 'in_progress', 'finalizing',
    'completed', 'cancellation_requested', 'cancelling', 'cancelled', 'failed', 'expired')
    OR provider_batch_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_content_script_provider_batches_cancel
  ON content_script_provider_batches(status, updated_at)
  WHERE status IN ('cancellation_requested', 'cancelling');

-- Exactly-once provider accounting uses a new-table claim. Runtime writes the
-- claim and the existing api_usage row in one immediate transaction, so a
-- crash cannot retain only one side. The migration deliberately leaves the
-- predecessor-owned api_usage schema untouched.
CREATE TABLE api_usage_provider_batch_dedupe (
  provider TEXT NOT NULL CHECK (provider = 'openai'),
  provider_batch_id TEXT NOT NULL,
  api_usage_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (provider, provider_batch_id)
);
