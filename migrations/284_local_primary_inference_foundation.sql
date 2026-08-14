-- 284: additive local-primary inference control, telemetry, and durable script jobs.
--
-- The predecessor ignores every new column and table. Runtime routing is
-- seeded OFF for both environments, so applying this migration cannot start a
-- model call or alter the existing cloud path. No prompts or generated private
-- content are stored in inference telemetry; script request/result payloads
-- remain tenant-owned application data in the dedicated durable job tables.

-- Keep additions predecessor-compatible. The release classifier deliberately
-- rejects new NOT NULL/CHECK constraints on an existing table because an old
-- image may still write values that those constraints reject. Runtime readers
-- validate these policy values, while the defaults preserve old INSERT paths.
ALTER TABLE plan_configs ADD COLUMN local_operations_hourly INTEGER DEFAULT 0;
ALTER TABLE plan_configs ADD COLUMN local_operations_daily INTEGER DEFAULT 0;
ALTER TABLE plan_configs ADD COLUMN longform_scripts_daily INTEGER DEFAULT 0;
ALTER TABLE plan_configs ADD COLUMN active_content_jobs INTEGER DEFAULT 0;
ALTER TABLE plan_configs ADD COLUMN ordinary_context_tokens INTEGER DEFAULT 0;
ALTER TABLE plan_configs ADD COLUMN content_context_tokens INTEGER DEFAULT 0;
ALTER TABLE plan_configs ADD COLUMN script_segment_output_tokens INTEGER DEFAULT 0;
ALTER TABLE plan_configs ADD COLUMN local_queue_weight INTEGER DEFAULT 0;
ALTER TABLE plan_configs ADD COLUMN local_cloud_fallback_run_usd REAL DEFAULT 0;
ALTER TABLE plan_configs ADD COLUMN local_cloud_fallback_daily_usd REAL DEFAULT 0;

UPDATE plan_configs
SET local_operations_hourly = CASE plan_id WHEN 'pro' THEN 20 WHEN 'max' THEN 40 WHEN 'owner' THEN 1000 ELSE 0 END,
    local_operations_daily = CASE plan_id WHEN 'pro' THEN 100 WHEN 'max' THEN 200 WHEN 'owner' THEN 10000 ELSE 0 END,
    longform_scripts_daily = CASE plan_id WHEN 'pro' THEN 6 WHEN 'max' THEN 20 WHEN 'owner' THEN 1000 ELSE 0 END,
    active_content_jobs = CASE plan_id WHEN 'pro' THEN 1 WHEN 'max' THEN 2 WHEN 'owner' THEN 20 ELSE 0 END,
    ordinary_context_tokens = CASE plan_id WHEN 'pro' THEN 8192 WHEN 'max' THEN 12288 WHEN 'owner' THEN 16384 ELSE 0 END,
    content_context_tokens = CASE plan_id WHEN 'pro' THEN 12288 WHEN 'max' THEN 16384 WHEN 'owner' THEN 16384 ELSE 0 END,
    script_segment_output_tokens = CASE plan_id WHEN 'pro' THEN 5120 WHEN 'max' THEN 6144 WHEN 'owner' THEN 6144 ELSE 0 END,
    local_queue_weight = CASE plan_id WHEN 'pro' THEN 1 WHEN 'max' THEN 2 WHEN 'owner' THEN 4 ELSE 0 END,
    local_cloud_fallback_run_usd = CASE plan_id WHEN 'pro' THEN 0.15 WHEN 'max' THEN 0.25 WHEN 'owner' THEN 2.00 ELSE 0 END,
    local_cloud_fallback_daily_usd = CASE plan_id WHEN 'pro' THEN 0.40 WHEN 'max' THEN 0.60 WHEN 'owner' THEN 10.00 ELSE 0 END
WHERE plan_id IN ('free', 'beta', 'pro', 'max', 'owner');

CREATE TABLE local_inference_runtime_control (
  environment TEXT PRIMARY KEY CHECK (environment IN ('staging', 'production')),
  mode TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'shadow', 'canary', 'active')),
  rollout_percent INTEGER NOT NULL DEFAULT 0 CHECK (rollout_percent BETWEEN 0 AND 100),
  model_manifest_version TEXT,
  active_model_digest TEXT,
  skill_profile_version TEXT,
  non_ai_p95_baseline_ms INTEGER CHECK (non_ai_p95_baseline_ms IS NULL OR non_ai_p95_baseline_ms >= 0),
  non_ai_baseline_sample_count INTEGER CHECK (non_ai_baseline_sample_count IS NULL OR non_ai_baseline_sample_count >= 0),
  non_ai_baseline_captured_at TEXT,
  end_user_error_rate_baseline_percent REAL CHECK (
    end_user_error_rate_baseline_percent IS NULL
    OR end_user_error_rate_baseline_percent BETWEEN 0 AND 100
  ),
  end_user_error_baseline_sample_count INTEGER CHECK (
    end_user_error_baseline_sample_count IS NULL OR end_user_error_baseline_sample_count >= 0
  ),
  reason TEXT NOT NULL DEFAULT 'migration_default_off',
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO local_inference_runtime_control (environment, mode, rollout_percent)
VALUES ('staging', 'off', 0), ('production', 'off', 0);

CREATE TABLE local_inference_control_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  environment TEXT NOT NULL CHECK (environment IN ('staging', 'production')),
  previous_mode TEXT NOT NULL CHECK (previous_mode IN ('off', 'shadow', 'canary', 'active')),
  mode TEXT NOT NULL CHECK (mode IN ('off', 'shadow', 'canary', 'active')),
  rollout_percent INTEGER NOT NULL CHECK (rollout_percent BETWEEN 0 AND 100),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('owner', 'system_monitor')),
  actor_user_id INTEGER CHECK (
    (actor_type = 'owner' AND actor_user_id IS NOT NULL AND actor_user_id > 0)
    OR (actor_type = 'system_monitor' AND (actor_user_id IS NULL OR actor_user_id > 0))
  ),
  model_manifest_version TEXT,
  active_model_digest TEXT,
  skill_profile_version TEXT,
  reason TEXT NOT NULL,
  evidence_reference TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_local_inference_control_events_created
  ON local_inference_control_events(environment, created_at DESC);

-- Typed, content-free evidence for critical boundary invariants. Normal
-- validator rejections do not belong here and cannot trigger an emergency
-- rollback. The schema and application allowlist intentionally match; a new
-- incident requires its concrete producer and mode-OFF handling in the same
-- release.
CREATE TABLE local_inference_safety_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  environment TEXT NOT NULL CHECK (environment IN ('staging', 'production')),
  incident_code TEXT NOT NULL CHECK (incident_code IN (
    'post_delivery_fallback_attempt',
    'tenant_isolation_escape',
    'secret_exposure',
    'prompt_injection_escape',
    'confirmation_bypass',
    'unsafe_output_served'
  )),
  source TEXT NOT NULL CHECK (length(trim(source)) > 0),
  tenant_id INTEGER CHECK (tenant_id IS NULL OR tenant_id > 0),
  user_id INTEGER CHECK (user_id IS NULL OR user_id > 0),
  run_id TEXT,
  blocked INTEGER NOT NULL CHECK (blocked IN (0, 1)),
  dedupe_bucket TEXT NOT NULL CHECK (length(dedupe_bucket) = 16),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_local_inference_safety_incidents_created
  ON local_inference_safety_incidents(environment, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_local_inference_safety_incidents_dedupe
  ON local_inference_safety_incidents(
    environment,
    incident_code,
    source,
    COALESCE(tenant_id, 0),
    COALESCE(user_id, 0),
    COALESCE(run_id, ''),
    dedupe_bucket
  );

CREATE TABLE skill_inference_runs (
  run_id TEXT PRIMARY KEY CHECK (length(trim(run_id)) > 0),
  operation_id TEXT NOT NULL CHECK (length(trim(operation_id)) > 0),
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  plan_id TEXT NOT NULL CHECK (length(trim(plan_id)) > 0),
  skill_id TEXT NOT NULL CHECK (skill_id IN ('secretary', 'content', 'training', 'triathlon', 'cooking', 'finance')),
  task_type TEXT NOT NULL CHECK (length(trim(task_type)) > 0),
  risk_class TEXT NOT NULL CHECK (risk_class IN ('low', 'medium', 'high', 'regulated')),
  execution_class TEXT NOT NULL CHECK (execution_class IN ('interactive', 'background', 'action_proposal')),
  evaluation_mode TEXT NOT NULL DEFAULT 'production' CHECK (evaluation_mode IN ('production', 'shadow')),
  local_admission_requested INTEGER NOT NULL CHECK (local_admission_requested IN (0, 1)),
  profile_version TEXT NOT NULL CHECK (length(trim(profile_version)) > 0),
  status TEXT NOT NULL CHECK (status IN ('admitted', 'running', 'completed', 'failed', 'cancelled')),
  final_route TEXT CHECK (final_route IS NULL OR final_route IN ('local', 'cloud', 'none')),
  provider TEXT,
  model_id TEXT,
  model_digest TEXT,
  schema_id TEXT,
  context_limit_tokens INTEGER NOT NULL CHECK (context_limit_tokens > 0),
  output_limit_tokens INTEGER NOT NULL CHECK (output_limit_tokens > 0),
  validation_status TEXT CHECK (validation_status IS NULL OR validation_status IN ('valid', 'invalid', 'not_requested')),
  fallback_reason TEXT,
  queue_wait_ms INTEGER CHECK (queue_wait_ms IS NULL OR queue_wait_ms >= 0),
  first_token_ms INTEGER CHECK (first_token_ms IS NULL OR first_token_ms >= 0),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  generation_tokens_per_second REAL CHECK (generation_tokens_per_second IS NULL OR generation_tokens_per_second >= 0),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_skill_inference_runs_scope_created
  ON skill_inference_runs(tenant_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_skill_inference_runs_operation
  ON skill_inference_runs(tenant_id, user_id, operation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_skill_inference_runs_route_created
  ON skill_inference_runs(final_route, created_at DESC);

CREATE TABLE skill_inference_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES skill_inference_runs(run_id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  route TEXT NOT NULL CHECK (route IN ('local', 'cloud')),
  provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
  model_id TEXT,
  model_digest TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'cancelled')),
  failure_reason TEXT,
  queue_wait_ms INTEGER CHECK (queue_wait_ms IS NULL OR queue_wait_ms >= 0),
  first_token_ms INTEGER CHECK (first_token_ms IS NULL OR first_token_ms >= 0),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  generation_tokens_per_second REAL CHECK (generation_tokens_per_second IS NULL OR generation_tokens_per_second >= 0),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(run_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_skill_inference_attempts_run
  ON skill_inference_attempts(run_id, attempt_number);

-- A short-lived, user-scoped admission fence closes the interval between an
-- account-deletion request and the final erasure transaction. The backend has
-- one process per environment. Same-process concurrent deletion stays fenced;
-- a restarted process takes ownership immediately because the abandoned
-- controller registry can no longer contain live provider work. Expiry is a
-- final recovery bound for malformed or externally-created rows.
CREATE TABLE local_inference_account_deletion_fences (
  user_id INTEGER PRIMARY KEY CHECK (user_id > 0),
  fence_token TEXT NOT NULL UNIQUE CHECK (length(fence_token) = 36),
  runtime_instance_id TEXT NOT NULL CHECK (length(runtime_instance_id) = 36),
  expires_at INTEGER NOT NULL CHECK (expires_at > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_local_inference_account_deletion_fences_expiry
  ON local_inference_account_deletion_fences(expires_at);

-- Durable replay protection for signed Content Engine delegations. A UNIQUE
-- token/nonce pair is consumed atomically across backend instances; expiry
-- cleanup keeps the table bounded without storing prompts or output.
CREATE TABLE internal_inference_request_nonces (
  token_id TEXT NOT NULL CHECK (length(token_id) = 36),
  request_nonce TEXT NOT NULL CHECK (length(request_nonce) = 36),
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  operation_id TEXT NOT NULL CHECK (length(trim(operation_id)) > 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > 0),
  consumed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (token_id, request_nonce)
);

CREATE INDEX IF NOT EXISTS idx_internal_inference_request_nonces_expiry
  ON internal_inference_request_nonces(expires_at);

CREATE TABLE content_script_jobs (
  job_id TEXT PRIMARY KEY CHECK (length(trim(job_id)) > 0),
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  owner_user_id INTEGER NOT NULL CHECK (owner_user_id > 0),
  plan_id TEXT NOT NULL CHECK (length(trim(plan_id)) > 0),
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) > 0),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  operation_id TEXT NOT NULL CHECK (length(trim(operation_id)) > 0),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  -- Non-sensitive reporting dimension. Keeping the normalized duration
  -- outside encrypted request_json lets pricing evidence distinguish actual
  -- long-form jobs without decrypting customer content.
  target_duration_seconds INTEGER NOT NULL DEFAULT 480
    CHECK (target_duration_seconds BETWEEN 15 AND 900),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_capacity', 'completed', 'failed', 'cancelled')),
  stage TEXT NOT NULL DEFAULT 'queued',
  progress_percent INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  warning_codes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(warning_codes_json)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  route TEXT CHECK (route IS NULL OR route IN ('local', 'cloud', 'mixed', 'none')),
  model_digest TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  infrastructure_requeue_count INTEGER NOT NULL DEFAULT 0
    CHECK (infrastructure_requeue_count >= 0),
  final_repair_count INTEGER NOT NULL DEFAULT 0
    CHECK (final_repair_count BETWEEN 0 AND 1),
  next_attempt_at TEXT,
  fair_use_admitted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  lease_token TEXT,
  lease_expires_at TEXT,
  cancellation_requested_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(tenant_id, owner_user_id, idempotency_key),
  CHECK ((status = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'running' AND lease_token IS NULL AND lease_expires_at IS NULL)),
  CHECK (status <> 'completed' OR (result_json IS NOT NULL AND completed_at IS NOT NULL)),
  CHECK (status <> 'cancelled' OR cancellation_requested_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_content_script_jobs_scope_created
  ON content_script_jobs(tenant_id, owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_script_jobs_scope_fair_use
  ON content_script_jobs(tenant_id, owner_user_id, fair_use_admitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_script_jobs_claim
  ON content_script_jobs(status, next_attempt_at, lease_expires_at, created_at);

CREATE TABLE content_script_job_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES content_script_jobs(job_id) ON DELETE CASCADE,
  section_index INTEGER NOT NULL CHECK (section_index >= 0),
  section_key TEXT NOT NULL CHECK (length(trim(section_key)) > 0),
  state TEXT NOT NULL CHECK (state IN ('planned', 'generating', 'validated', 'invalid', 'cancelled')),
  word_budget INTEGER CHECK (word_budget IS NULL OR word_budget > 0),
  output_json TEXT CHECK (output_json IS NULL OR json_valid(output_json)),
  validation_json TEXT CHECK (validation_json IS NULL OR json_valid(validation_json)),
  -- Cloud remains schema-compatible for the plan's future checkpoint-boundary
  -- fallback, while the initial private Content worker writes local only.
  route TEXT CHECK (route IS NULL OR route IN ('local', 'cloud')),
  model_digest TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(job_id, section_index)
);

CREATE INDEX IF NOT EXISTS idx_content_script_job_checkpoints_job
  ON content_script_job_checkpoints(job_id, section_index);

-- Rollback keeps additive telemetry and tenant-owned job evidence. Set both
-- runtime-control rows to mode='off' before rolling the application image back;
-- the predecessor ignores these objects and all new plan columns.
