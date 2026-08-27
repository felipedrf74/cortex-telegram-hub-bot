-- 297: indexed, governed private-data retention sweeps.
--
-- These plain lookup indexes lead with the columns used by the 30-day, 90-day,
-- 12-calendar-month, and 365-day retention jobs. They are add-only so deployment
-- avoids an in-migration DELETE or table rewrite; CREATE INDEX takes the normal
-- bounded schema lock. Runtime predicates retain the exact eligibility rules.

-- A permanent start fence prevents a user retry or late Batch persistence from
-- racing remote file deletion. The short-lived claim serializes provider calls;
-- a stale claim may be resumed after process loss without reopening retry.
ALTER TABLE content_script_provider_batches
  ADD COLUMN provider_files_cleanup_started_at TEXT;
ALTER TABLE content_script_provider_batches
  ADD COLUMN provider_files_cleanup_claim TEXT;
ALTER TABLE content_script_provider_batches
  ADD COLUMN provider_files_cleanup_claimed_at TEXT;

-- A provider identifier can be accepted remotely immediately before process
-- loss. Persist only content-free stage identity before each network call so
-- restart/account-erasure reconciliation can recover that identifier without
-- retaining another copy of the request or result.
ALTER TABLE content_script_provider_batches
  ADD COLUMN input_file_intent_filename TEXT;
ALTER TABLE content_script_provider_batches
  ADD COLUMN input_file_intent_at TEXT;
ALTER TABLE content_script_provider_batches
  ADD COLUMN batch_create_intent_at TEXT;
-- Provider inventory listing is eventually consistent. Absence becomes proof
-- only after the runtime records two independent observations beyond its
-- visibility grace; upload and create stages are tracked independently.
ALTER TABLE content_script_provider_batches
  ADD COLUMN input_file_intent_absence_count INTEGER DEFAULT 0;
ALTER TABLE content_script_provider_batches
  ADD COLUMN input_file_intent_absence_observed_at TEXT;
ALTER TABLE content_script_provider_batches
  ADD COLUMN input_file_intent_absence_confirmed_at TEXT;
ALTER TABLE content_script_provider_batches
  ADD COLUMN batch_create_intent_absence_count INTEGER DEFAULT 0;
ALTER TABLE content_script_provider_batches
  ADD COLUMN batch_create_intent_absence_observed_at TEXT;
ALTER TABLE content_script_provider_batches
  ADD COLUMN batch_create_intent_absence_confirmed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_content_script_batches_unresolved_provider_intent
  ON content_script_provider_batches(
    owner_user_id,
    provider_files_deleted_at,
    updated_at,
    job_id,
    stage_key
  );

CREATE INDEX IF NOT EXISTS idx_content_script_batches_unresolved_intent_retention
  ON content_script_provider_batches(
    job_id,
    tenant_id,
    owner_user_id,
    stage_key,
    provider_files_deleted_at
  );

-- Retention has two independently fallible provider-cleanup branches. Persist
-- the next branch so even a one-page scheduler budget alternates across runs;
-- a large unresolved-intent backlog cannot starve deletion of known files (or
-- vice versa) after a process restart.
CREATE TABLE IF NOT EXISTS content_script_provider_retention_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  next_branch TEXT NOT NULL CHECK (next_branch IN ('intent', 'known_file')),
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO content_script_provider_retention_control (
  singleton, next_branch, updated_at
) VALUES (1, 'intent', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- Account erasure removes private invoice bytes before their ownership rows.
-- These receipts make that external/local cleanup resumable and let the
-- transactional row erasure fail closed when artifact deletion is unproven.
ALTER TABLE invoice_queue ADD COLUMN local_file_deleted_at TEXT;
-- Queue flushes can overlap during scheduler/manual invocation. A durable,
-- expiring claim prevents two workers from filing the same spool concurrently;
-- process loss releases ownership after the lease expires.
ALTER TABLE invoice_queue ADD COLUMN flush_claim_token TEXT;
ALTER TABLE invoice_queue ADD COLUMN flush_claim_expires_at INTEGER;
ALTER TABLE invoice_filings ADD COLUMN object_deleted_at TEXT;
-- Legacy SCP copies are a second artifact even after object-storage backfill.
-- Only the mounted-root maintenance command may set this proof after a
-- no-symlink, checksum-bound deletion/absence check.
ALTER TABLE invoice_filings ADD COLUMN legacy_remote_deleted_at TEXT;

-- Filesystem writes are owned before the first byte is created. This manifest
-- survives the caller crashing before invoice_queue/invoice_filings can be
-- populated, so account erasure can reconcile no-row artifacts fail-closed.
CREATE TABLE IF NOT EXISTS invoice_artifact_manifests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('queue_spool', 'stored_object')),
  artifact_locator TEXT NOT NULL,
  storage_backend TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('writing', 'stored', 'failed', 'deleting', 'deleted')),
  write_token TEXT NOT NULL,
  write_lease_expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  stored_at TEXT,
  deleted_at TEXT,
  UNIQUE(artifact_kind, artifact_locator)
);

CREATE INDEX IF NOT EXISTS idx_invoice_artifact_manifest_account_cleanup
  ON invoice_artifact_manifests(user_id, deleted_at, state, id);

CREATE INDEX IF NOT EXISTS idx_invoice_queue_account_artifact_cleanup
  ON invoice_queue(user_id, local_file_deleted_at, id);

CREATE INDEX IF NOT EXISTS idx_invoice_queue_flush_claim
  ON invoice_queue(status, flush_claim_expires_at, created_at, id);

CREATE INDEX IF NOT EXISTS idx_invoice_filings_account_artifact_cleanup
  ON invoice_filings(user_id, object_deleted_at, id);

CREATE INDEX IF NOT EXISTS idx_content_script_jobs_private_retention
  ON content_script_jobs(
    completed_at,
    updated_at,
    job_id
  );

CREATE INDEX IF NOT EXISTS idx_skill_inference_runs_retention
  ON skill_inference_runs(
    completed_at,
    updated_at,
    created_at,
    run_id
  );

CREATE INDEX IF NOT EXISTS idx_audit_trail_security_admin_retention
  ON audit_trail(action, ts, id);

CREATE INDEX IF NOT EXISTS idx_local_inference_safety_retention
  ON local_inference_safety_incidents(created_at, id);

CREATE INDEX IF NOT EXISTS idx_content_script_batches_file_retention
  ON content_script_provider_batches(
    job_id,
    stage_key,
    provider_files_deleted_at,
    status
  );

CREATE INDEX IF NOT EXISTS idx_content_script_batches_upload_file_retention
  ON content_script_provider_batches(
    job_id,
    stage_key,
    provider_files_deleted_at,
    provider_batch_id,
    status
  );
