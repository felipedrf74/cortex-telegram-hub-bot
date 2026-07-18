-- Migration 249 is a forward-only writable-root cutover. If any legacy root
-- was normalized, rollback requires the exact pre-249 database snapshot and
-- matching older runtime. This down path is allowed only for an empty rehearsal.

CREATE TEMP TABLE _content_editorial_exit_rollback_guard (
  value INTEGER NOT NULL CHECK (value = 0)
);

INSERT INTO _content_editorial_exit_rollback_guard(value)
SELECT COUNT(*) FROM content_editorial_workspace_exit_bindings;

DROP TABLE _content_editorial_exit_rollback_guard;

DROP TRIGGER IF EXISTS trg_content_source_review_records_archive_delete;
DROP TRIGGER IF EXISTS trg_content_source_review_records_archive_update;
DROP TRIGGER IF EXISTS trg_content_source_review_records_archive_insert;
DROP TRIGGER IF EXISTS trg_content_approval_records_archive_delete;
DROP TRIGGER IF EXISTS trg_content_approval_records_archive_update;
DROP TRIGGER IF EXISTS trg_content_approval_records_archive_insert;
DROP TRIGGER IF EXISTS trg_content_domain_objects_canonical_type_update;
DROP TRIGGER IF EXISTS trg_content_domain_objects_canonical_type_insert;
DROP TRIGGER IF EXISTS trg_content_editorial_exit_binding_immutable;

DROP INDEX IF EXISTS idx_content_editorial_workspace_exit_scope;
DROP TABLE IF EXISTS content_editorial_workspace_exit_bindings;

CREATE TABLE content_workspace_product_metrics_v3 (
  signal TEXT PRIMARY KEY CHECK (signal IN (
    'idea_captured', 'project_created', 'revision_saved', 'revision_restored',
    'content_approved', 'content_scheduled', 'content_published',
    'script_generated', 'platform_variant_generated',
    'proposal_accepted', 'proposal_rejected',
    'legacy_pipeline_compatibility_read',
    'legacy_ideas_compatibility_read',
    'legacy_pipeline_compatibility_mutation',
    'legacy_topics_compatibility_read',
    'legacy_topics_compatibility_mutation'
  )),
  metric_value INTEGER NOT NULL DEFAULT 0
    CHECK (metric_value BETWEEN 0 AND 9007199254740991)
);

INSERT INTO content_workspace_product_metrics_v3
SELECT signal, metric_value
  FROM content_workspace_product_metrics
 WHERE signal NOT IN (
   'legacy_editorial_compatibility_read',
   'legacy_editorial_compatibility_mutation'
 );
DROP TABLE content_workspace_product_metrics;
ALTER TABLE content_workspace_product_metrics_v3 RENAME TO content_workspace_product_metrics;
