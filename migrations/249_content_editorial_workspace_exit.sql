-- Migration 249: retire the pre-workspace editorial lifecycle as a writer.
--
-- content_domain_objects remains the one canonical item/project root. Active,
-- private legacy editorial-shaped rows are normalized in place so their stable
-- ids and historical events remain usable. Approval, scheduling, and
-- publication claims are evidence only: they are preserved in the immutable
-- binding and moved to review-required canonical truth. No artifact, revision,
-- source lineage, schedule binding, or publication confirmation is fabricated.
--
-- The old content_approval_records and content_source_review_records tables are
-- retained strictly for export/audit history. Runtime writes are blocked at the
-- database boundary. Account erasure remains possible only through the existing
-- short-lived legal-erasure authorization.
--
-- This migration crosses a writable-root boundary. An older runtime is safe
-- only with its exact pre-249 database snapshot. Removal requires zero legacy
-- compatibility traffic for two supported release windows, canonical Decision
-- Center targets, and verified export/deletion coverage for historical ledgers.

-- Shared/public/internal legacy roots cannot be promoted into the private
-- workspace without inventing collaboration roles or publication authority.
-- Abort before any persistent cutover write and require an owner-reviewed
-- reconciliation against the exact pre-249 snapshot.
CREATE TEMP TABLE _content_editorial_unsupported_scope_guard (
  value INTEGER NOT NULL CHECK (value = 0)
);

INSERT INTO _content_editorial_unsupported_scope_guard(value)
SELECT COUNT(*)
  FROM content_domain_objects
 WHERE scope_status = 'active'
   AND object_type NOT IN ('content_item', 'project')
   AND (
     tenant_id <= 0
     OR owner_user_id <= 0
     OR visibility_scope <> 'user_private'
   );

DROP TABLE _content_editorial_unsupported_scope_guard;

CREATE TABLE IF NOT EXISTS content_editorial_workspace_exit_bindings (
  item_id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  owner_user_id INTEGER NOT NULL CHECK (owner_user_id > 0),
  legacy_object_type TEXT NOT NULL,
  legacy_lifecycle_state TEXT NOT NULL,
  legacy_editorial_state TEXT NOT NULL,
  legacy_approval_state TEXT NOT NULL,
  legacy_review_required INTEGER NOT NULL CHECK (legacy_review_required IN (0, 1)),
  legacy_review_reason_codes_json TEXT NOT NULL,
  legacy_approved_by INTEGER,
  legacy_approved_at TEXT,
  legacy_rejected_reason TEXT,
  legacy_archived_at TEXT,
  legacy_scheduled_for TEXT,
  legacy_secretary_intent_id TEXT,
  legacy_secretary_agenda_item_id TEXT,
  legacy_production_state TEXT NOT NULL,
  legacy_artifact_phase TEXT NOT NULL,
  legacy_current_artifact_id INTEGER,
  legacy_ontology_metadata_json TEXT NOT NULL,
  legacy_audit_metadata_json TEXT NOT NULL,
  legacy_workflow_version INTEGER NOT NULL CHECK (legacy_workflow_version > 0),
  migration_reason_codes_json TEXT NOT NULL
    CHECK (json_valid(migration_reason_codes_json) AND json_type(migration_reason_codes_json) = 'array'),
  schema_version TEXT NOT NULL DEFAULT 'content-editorial-workspace-exit-v1'
    CHECK (schema_version = 'content-editorial-workspace-exit-v1'),
  migrated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (item_id, tenant_id, owner_user_id)
    REFERENCES content_domain_objects(id, tenant_id, owner_user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_content_editorial_workspace_exit_scope
  ON content_editorial_workspace_exit_bindings(tenant_id, owner_user_id, item_id);

INSERT OR IGNORE INTO content_editorial_workspace_exit_bindings (
  item_id, tenant_id, owner_user_id,
  legacy_object_type, legacy_lifecycle_state, legacy_editorial_state,
  legacy_approval_state, legacy_review_required,
  legacy_review_reason_codes_json, legacy_approved_by, legacy_approved_at,
  legacy_rejected_reason, legacy_archived_at, legacy_scheduled_for,
  legacy_secretary_intent_id, legacy_secretary_agenda_item_id,
  legacy_production_state, legacy_artifact_phase, legacy_current_artifact_id,
  legacy_ontology_metadata_json, legacy_audit_metadata_json,
  legacy_workflow_version, migration_reason_codes_json
)
SELECT
  item.id,
  item.tenant_id,
  item.owner_user_id,
  item.object_type,
  COALESCE(item.lifecycle_state, 'captured'),
  COALESCE(item.editorial_state, 'idea'),
  COALESCE(item.approval_state, 'not_required'),
  CASE WHEN item.review_required = 1 THEN 1 ELSE 0 END,
  COALESCE(item.review_reason_codes_json, '[]'),
  item.approved_by,
  item.approved_at,
  item.rejected_reason,
  item.archived_at,
  item.scheduled_for,
  item.secretary_intent_id,
  item.secretary_agenda_item_id,
  COALESCE(item.production_state, 'inbox'),
  COALESCE(item.artifact_phase, 'idea'),
  item.current_artifact_id,
  CASE WHEN json_valid(item.ontology_metadata_json) THEN item.ontology_metadata_json ELSE '{}' END,
  CASE WHEN json_valid(item.audit_metadata_json) THEN item.audit_metadata_json ELSE '{}' END,
  CASE WHEN item.workflow_version > 0 THEN item.workflow_version ELSE 1 END,
  CASE lower(COALESCE(item.editorial_state, item.lifecycle_state, 'idea'))
    WHEN 'published' THEN json_array(
      'legacy_publication_claim_requires_external_verification',
      'legacy_content_parity_pending'
    )
    WHEN 'scheduled' THEN json_array(
      'legacy_schedule_claim_requires_canonical_schedule_binding',
      'legacy_content_parity_pending'
    )
    WHEN 'approved' THEN json_array(
      'legacy_approval_claim_requires_canonical_revision_and_lineage',
      'legacy_content_parity_pending'
    )
    WHEN 'reviewed' THEN json_array(
      'legacy_review_requires_canonical_revision',
      'legacy_content_parity_pending'
    )
    ELSE CASE
      WHEN item.review_required = 1 OR COALESCE(item.approval_state, '') = 'required'
        THEN json_array(
          'legacy_review_requires_canonical_revision',
          'legacy_content_parity_pending'
        )
      ELSE json_array('legacy_content_parity_pending')
    END
  END
FROM content_domain_objects AS item
WHERE item.tenant_id > 0
  AND item.owner_user_id > 0
  AND item.visibility_scope = 'user_private'
  AND item.scope_status = 'active'
  AND item.object_type NOT IN ('content_item', 'project');

UPDATE content_domain_objects
   SET object_type = 'content_item',
       production_state = CASE
         WHEN lower(COALESCE(editorial_state, lifecycle_state, '')) = 'archived' THEN 'archived'
         WHEN lower(COALESCE(editorial_state, lifecycle_state, '')) = 'rejected' THEN 'rejected'
         WHEN lower(COALESCE(editorial_state, lifecycle_state, '')) IN ('reviewed', 'approved', 'scheduled', 'published')
           OR review_required = 1
           OR COALESCE(approval_state, '') = 'required'
           THEN 'review'
         WHEN lower(COALESCE(editorial_state, lifecycle_state, '')) = 'idea' THEN 'inbox'
         ELSE 'active'
       END,
       lifecycle_state = CASE
         WHEN lower(COALESCE(editorial_state, lifecycle_state, '')) = 'archived' THEN 'archived'
         WHEN lower(COALESCE(editorial_state, lifecycle_state, '')) = 'rejected' THEN 'rejected'
         WHEN lower(COALESCE(editorial_state, lifecycle_state, '')) IN ('reviewed', 'approved', 'scheduled', 'published')
           OR review_required = 1
           OR COALESCE(approval_state, '') = 'required'
           THEN 'review'
         WHEN lower(COALESCE(editorial_state, lifecycle_state, '')) = 'idea' THEN 'inbox'
         ELSE 'active'
       END,
       artifact_phase = 'idea',
       editorial_state = CASE
         WHEN lower(COALESCE(editorial_state, lifecycle_state, '')) = 'archived' THEN 'archived'
         WHEN lower(COALESCE(editorial_state, lifecycle_state, '')) = 'rejected' THEN 'rejected'
         WHEN lower(COALESCE(editorial_state, lifecycle_state, '')) IN ('reviewed', 'approved', 'scheduled', 'published')
           OR review_required = 1
           OR COALESCE(approval_state, '') = 'required'
           THEN 'reviewed'
         ELSE 'idea'
       END,
       approval_state = CASE
         WHEN lower(COALESCE(editorial_state, lifecycle_state, '')) = 'rejected' THEN 'rejected'
         WHEN lower(COALESCE(editorial_state, lifecycle_state, '')) IN ('reviewed', 'approved', 'scheduled', 'published')
           OR review_required = 1
           OR COALESCE(approval_state, '') = 'required'
           THEN 'required'
         ELSE 'not_required'
       END,
       review_required = CASE
         WHEN lower(COALESCE(editorial_state, lifecycle_state, '')) IN ('reviewed', 'approved', 'scheduled', 'published')
           OR review_required = 1
           OR COALESCE(approval_state, '') = 'required'
           THEN 1
         ELSE 0
       END,
       review_reason_codes_json = (
         SELECT binding.migration_reason_codes_json
           FROM content_editorial_workspace_exit_bindings AS binding
          WHERE binding.item_id = content_domain_objects.id
       ),
       approved_by = NULL,
       approved_at = NULL,
       scheduled_for = NULL,
       secretary_intent_id = NULL,
       secretary_agenda_item_id = NULL,
       current_artifact_id = NULL,
       workspace_schema_version = 'content-workspace-v1',
       ontology_metadata_json = json_set(
         CASE WHEN json_valid(ontology_metadata_json) THEN ontology_metadata_json ELSE '{}' END,
         '$.legacyEditorialExit',
         json_object(
           'migrationVersion', 249,
           'contentParity', 'metadata_only',
           'approvalEvidence', 'not_reconstructed',
           'scheduleEvidence', 'not_reconstructed',
           'publicationEvidence', 'not_reconstructed'
         )
       ),
       audit_metadata_json = json_set(
         CASE WHEN json_valid(audit_metadata_json) THEN audit_metadata_json ELSE '{}' END,
         '$.legacyEditorialExit',
         json_object(
           'migrationVersion', 249,
           'bindingTable', 'content_editorial_workspace_exit_bindings',
           'rollbackMode', 'exact_runtime_and_pre_249_database_snapshot'
         )
       ),
       updated_by = owner_user_id,
       updated_at = datetime('now'),
       workflow_version = CASE WHEN workflow_version > 0 THEN workflow_version + 1 ELSE 2 END
 WHERE id IN (SELECT item_id FROM content_editorial_workspace_exit_bindings)
   AND object_type NOT IN ('content_item', 'project');

INSERT INTO content_workflow_events (
  tenant_id, owner_user_id, visibility_scope, scope_status,
  object_type, object_id, action, from_state, to_state,
  approval_state, review_required, reason_codes_json,
  actor_user_id, metadata_json
)
SELECT
  binding.tenant_id,
  binding.owner_user_id,
  'user_private',
  'active',
  'content_item',
  CAST(binding.item_id AS TEXT),
  'legacy_editorial_migrated',
  binding.legacy_editorial_state,
  item.production_state,
  item.approval_state,
  item.review_required,
  binding.migration_reason_codes_json,
  binding.owner_user_id,
  json_object(
    'schemaVersion', 'content-editorial-workspace-exit-v1',
    'legacyObjectType', binding.legacy_object_type,
    'contentParity', 'metadata_only',
    'publicationExecution', 'not_performed'
  )
FROM content_editorial_workspace_exit_bindings AS binding
JOIN content_domain_objects AS item
  ON item.id = binding.item_id
 AND item.tenant_id = binding.tenant_id
 AND item.owner_user_id = binding.owner_user_id
WHERE NOT EXISTS (
  SELECT 1
    FROM content_workflow_events AS event
   WHERE event.tenant_id = binding.tenant_id
     AND event.owner_user_id = binding.owner_user_id
     AND event.object_type = 'content_item'
     AND event.object_id = CAST(binding.item_id AS TEXT)
     AND event.action = 'legacy_editorial_migrated'
);

CREATE TRIGGER IF NOT EXISTS trg_content_editorial_exit_binding_immutable
BEFORE UPDATE ON content_editorial_workspace_exit_bindings
BEGIN
  SELECT RAISE(ABORT, 'legacy editorial exit binding is immutable');
END;

-- No post-cutover runtime may recreate another editorial-shaped root. Exact
-- snapshot rollback is the only supported way to run an older binary.
CREATE TRIGGER IF NOT EXISTS trg_content_domain_objects_canonical_type_insert
BEFORE INSERT ON content_domain_objects
WHEN NEW.object_type NOT IN ('content_item', 'project')
BEGIN
  SELECT RAISE(ABORT, 'legacy editorial content roots are read-only after migration 249');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_domain_objects_canonical_type_update
BEFORE UPDATE OF object_type ON content_domain_objects
WHEN NEW.object_type NOT IN ('content_item', 'project')
BEGIN
  SELECT RAISE(ABORT, 'legacy editorial content roots are read-only after migration 249');
END;

CREATE TABLE IF NOT EXISTS content_source_review_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  owner_user_id INTEGER NOT NULL,
  visibility_scope TEXT NOT NULL DEFAULT 'user_private',
  scope_status TEXT NOT NULL DEFAULT 'active',
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  review_state TEXT NOT NULL,
  grounding_status TEXT,
  reason_codes_json TEXT NOT NULL DEFAULT '[]',
  reviewed_by INTEGER NOT NULL,
  reviewed_at TEXT NOT NULL DEFAULT (datetime('now')),
  notes TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TRIGGER IF NOT EXISTS trg_content_approval_records_archive_insert
BEFORE INSERT ON content_approval_records
BEGIN
  SELECT RAISE(ABORT, 'content_approval_records is historical after migration 249');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_approval_records_archive_update
BEFORE UPDATE ON content_approval_records
BEGIN
  SELECT RAISE(ABORT, 'content_approval_records is historical after migration 249');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_approval_records_archive_delete
BEFORE DELETE ON content_approval_records
WHEN NOT EXISTS (
  SELECT 1
    FROM training_revision_erasure_authorizations AS authorization
   WHERE authorization.subject_user_id = OLD.owner_user_id
     AND authorization.reason IN ('ACCOUNT_DELETION', 'LEGAL_ERASURE')
     AND datetime(authorization.expires_at) >= datetime('now')
)
BEGIN
  SELECT RAISE(ABORT, 'content_approval_records is historical after migration 249');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_source_review_records_archive_insert
BEFORE INSERT ON content_source_review_records
BEGIN
  SELECT RAISE(ABORT, 'content_source_review_records is historical after migration 249');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_source_review_records_archive_update
BEFORE UPDATE ON content_source_review_records
BEGIN
  SELECT RAISE(ABORT, 'content_source_review_records is historical after migration 249');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_source_review_records_archive_delete
BEFORE DELETE ON content_source_review_records
WHEN NOT EXISTS (
  SELECT 1
    FROM training_revision_erasure_authorizations AS authorization
   WHERE authorization.subject_user_id = OLD.owner_user_id
     AND authorization.reason IN ('ACCOUNT_DELETION', 'LEGAL_ERASURE')
     AND datetime(authorization.expires_at) >= datetime('now')
)
BEGIN
  SELECT RAISE(ABORT, 'content_source_review_records is historical after migration 249');
END;

-- Closed aggregate-only rollout counters. No identity, content, timestamp,
-- URL, hash, prompt, or provider response is retained.
CREATE TABLE content_workspace_product_metrics_v4 (
  signal TEXT PRIMARY KEY CHECK (signal IN (
    'idea_captured', 'project_created', 'revision_saved', 'revision_restored',
    'content_approved', 'content_scheduled', 'content_published',
    'script_generated', 'platform_variant_generated',
    'proposal_accepted', 'proposal_rejected',
    'legacy_pipeline_compatibility_read',
    'legacy_ideas_compatibility_read',
    'legacy_pipeline_compatibility_mutation',
    'legacy_topics_compatibility_read',
    'legacy_topics_compatibility_mutation',
    'legacy_editorial_compatibility_read',
    'legacy_editorial_compatibility_mutation'
  )),
  metric_value INTEGER NOT NULL DEFAULT 0
    CHECK (metric_value BETWEEN 0 AND 9007199254740991)
);

INSERT INTO content_workspace_product_metrics_v4
SELECT * FROM content_workspace_product_metrics;
DROP TABLE content_workspace_product_metrics;
ALTER TABLE content_workspace_product_metrics_v4 RENAME TO content_workspace_product_metrics;
