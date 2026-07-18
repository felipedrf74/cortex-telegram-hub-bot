-- Migration 245: durable, privacy-bounded Content workspace observability.
--
-- These tables store global aggregate counters only. They intentionally have
-- no tenant/user identity, timestamps, free-form metadata, content, prompts,
-- URLs, hashes, payloads, or provider responses. Metrics are disposable and
-- never participate in user workflow correctness.

CREATE TABLE IF NOT EXISTS content_workspace_reliability_metrics (
  counter_name TEXT PRIMARY KEY CHECK (counter_name IN (
    'workspace_operation_total',
    'workspace_operation_failure_total',
    'item_create_success_total',
    'revision_save_success_total',
    'revision_save_no_change_total',
    'revision_restore_success_total',
    'mutation_conflict_total',
    'autosave_conflict_total',
    'idempotent_replay_total',
    'lineage_record_success_total',
    'lineage_policy_block_total',
    'generation_success_total',
    'generation_failure_total',
    'generation_blocked_total',
    'proposal_created_total',
    'proposal_accepted_total',
    'proposal_rejected_total',
    'proposal_conflict_total',
    'schedule_preview_success_total',
    'schedule_confirm_success_total',
    'schedule_cancel_success_total',
    'schedule_failure_total',
    'schedule_conflict_total'
  )),
  metric_value INTEGER NOT NULL DEFAULT 0
    CHECK (metric_value BETWEEN 0 AND 9007199254740991)
);

CREATE TABLE IF NOT EXISTS content_workspace_operation_metrics (
  operation TEXT PRIMARY KEY CHECK (operation IN (
    'item_create', 'item_update', 'item_transition', 'item_delete',
    'item_restore', 'artifact_create', 'revision_save', 'revision_restore',
    'source_register', 'lineage_record', 'generation',
    'agent_job_create', 'agent_job_run', 'agent_job_cancel', 'agent_job_retry',
    'proposal_create', 'proposal_accept', 'proposal_reject',
    'schedule_preview', 'schedule_confirm', 'schedule_cancel'
  )),
  success_count INTEGER NOT NULL DEFAULT 0,
  replayed_count INTEGER NOT NULL DEFAULT 0,
  no_change_count INTEGER NOT NULL DEFAULT 0,
  conflict_count INTEGER NOT NULL DEFAULT 0,
  blocked_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  timer_count INTEGER NOT NULL DEFAULT 0,
  timer_total_ms INTEGER NOT NULL DEFAULT 0,
  timer_min_ms INTEGER,
  timer_max_ms INTEGER,
  bucket_lt_50_ms INTEGER NOT NULL DEFAULT 0,
  bucket_lt_250_ms INTEGER NOT NULL DEFAULT 0,
  bucket_lt_1000_ms INTEGER NOT NULL DEFAULT 0,
  bucket_lt_5000_ms INTEGER NOT NULL DEFAULT 0,
  bucket_lt_30000_ms INTEGER NOT NULL DEFAULT 0,
  bucket_gte_30000_ms INTEGER NOT NULL DEFAULT 0,
  CHECK (
    success_count BETWEEN 0 AND 9007199254740991
    AND replayed_count BETWEEN 0 AND 9007199254740991
    AND no_change_count BETWEEN 0 AND 9007199254740991
    AND conflict_count BETWEEN 0 AND 9007199254740991
    AND blocked_count BETWEEN 0 AND 9007199254740991
    AND failure_count BETWEEN 0 AND 9007199254740991
    AND accepted_count BETWEEN 0 AND 9007199254740991
    AND rejected_count BETWEEN 0 AND 9007199254740991
    AND timer_count BETWEEN 0 AND 9007199254740991
    AND timer_total_ms BETWEEN 0 AND 9007199254740991
    AND bucket_lt_50_ms BETWEEN 0 AND 9007199254740991
    AND bucket_lt_250_ms BETWEEN 0 AND 9007199254740991
    AND bucket_lt_1000_ms BETWEEN 0 AND 9007199254740991
    AND bucket_lt_5000_ms BETWEEN 0 AND 9007199254740991
    AND bucket_lt_30000_ms BETWEEN 0 AND 9007199254740991
    AND bucket_gte_30000_ms BETWEEN 0 AND 9007199254740991
  ),
  CHECK (
    timer_count = bucket_lt_50_ms + bucket_lt_250_ms + bucket_lt_1000_ms
      + bucket_lt_5000_ms + bucket_lt_30000_ms + bucket_gte_30000_ms
  ),
  CHECK (
    (timer_count = 0 AND timer_total_ms = 0 AND timer_min_ms IS NULL AND timer_max_ms IS NULL)
    OR
    (
      timer_count > 0
      AND timer_min_ms BETWEEN 0 AND 600000
      AND timer_max_ms BETWEEN 0 AND 600000
      AND timer_min_ms <= timer_max_ms
      AND timer_total_ms >= timer_max_ms
    )
  )
);

CREATE TABLE IF NOT EXISTS content_workspace_reason_metrics (
  reason TEXT PRIMARY KEY CHECK (reason IN (
    'base_revision_conflict', 'workflow_version_conflict',
    'idempotency_key_reused', 'lineage_immutable', 'claim_safety_block',
    'output_safety_block', 'output_size_block', 'proposal_stale',
    'agent_job_active', 'agent_base_stale', 'agent_lease_conflict',
    'agent_package_block', 'agent_package_integrity',
    'agent_review_incomplete', 'validation_rejected', 'not_found',
    'budget_denied', 'provider_failure', 'internal_failure',
    'schedule_preview_stale', 'schedule_slot_changed',
    'schedule_provider_failure', 'schedule_cancellation_failure'
  )),
  metric_value INTEGER NOT NULL DEFAULT 0
    CHECK (metric_value BETWEEN 0 AND 9007199254740991)
);

CREATE TABLE IF NOT EXISTS content_workspace_product_metrics (
  signal TEXT PRIMARY KEY CHECK (signal IN (
    'idea_captured', 'project_created', 'revision_saved', 'revision_restored',
    'content_approved', 'content_scheduled', 'content_published',
    'script_generated', 'platform_variant_generated',
    'proposal_accepted', 'proposal_rejected'
  )),
  metric_value INTEGER NOT NULL DEFAULT 0
    CHECK (metric_value BETWEEN 0 AND 9007199254740991)
);

CREATE TABLE IF NOT EXISTS content_workspace_quality_metrics (
  signal TEXT PRIMARY KEY CHECK (signal IN (
    'lineage_recorded_clear', 'unsupported_claim_warning',
    'claim_safety_blocked', 'generation_output_blocked',
    'generation_quality_warning', 'factuality_warning',
    'brand_voice_warning', 'platform_fit_warning'
  )),
  metric_value INTEGER NOT NULL DEFAULT 0
    CHECK (metric_value BETWEEN 0 AND 9007199254740991)
);
