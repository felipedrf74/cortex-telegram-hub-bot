-- Restore the migration-245 closed taxonomy. Aggregate rollout/compatibility
-- counters are intentionally disposable; all pre-248 totals are preserved.

CREATE TABLE content_workspace_operation_metrics_v2 (
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

INSERT INTO content_workspace_operation_metrics_v2
SELECT * FROM content_workspace_operation_metrics WHERE operation <> 'rollout_gate';
DROP TABLE content_workspace_operation_metrics;
ALTER TABLE content_workspace_operation_metrics_v2 RENAME TO content_workspace_operation_metrics;

CREATE TABLE content_workspace_reason_metrics_v2 (
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

INSERT INTO content_workspace_reason_metrics_v2
SELECT * FROM content_workspace_reason_metrics WHERE reason <> 'rollout_write_disabled';
DROP TABLE content_workspace_reason_metrics;
ALTER TABLE content_workspace_reason_metrics_v2 RENAME TO content_workspace_reason_metrics;

CREATE TABLE content_workspace_product_metrics_v2 (
  signal TEXT PRIMARY KEY CHECK (signal IN (
    'idea_captured', 'project_created', 'revision_saved', 'revision_restored',
    'content_approved', 'content_scheduled', 'content_published',
    'script_generated', 'platform_variant_generated',
    'proposal_accepted', 'proposal_rejected'
  )),
  metric_value INTEGER NOT NULL DEFAULT 0
    CHECK (metric_value BETWEEN 0 AND 9007199254740991)
);

INSERT INTO content_workspace_product_metrics_v2
SELECT * FROM content_workspace_product_metrics
 WHERE signal NOT LIKE 'legacy_%_compatibility_%';
DROP TABLE content_workspace_product_metrics;
ALTER TABLE content_workspace_product_metrics_v2 RENAME TO content_workspace_product_metrics;
