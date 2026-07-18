-- Migration 246: exit the legacy content_pipeline write path.
--
-- content_domain_objects remains the only Content item/project root. This
-- migration preserves scoped legacy inventory by importing each active,
-- private pipeline row once and recording an immutable ingress binding. The
-- binding is lineage/idempotency metadata; it is not a second content root.
--
-- Deployment compatibility: content_pipeline is retained only as a read-only
-- archive because legacy artifact-chain/export reads still reference it.
-- Migration 246 installs write-blocking triggers; an older binary MUST NOT run
-- against this schema. Rollback requires the exact predecessor runtime AND its
-- archived pre-246 database snapshot under docs/release/README.md, never a
-- code-only downgrade against the upgraded database. Runtime code at and after
-- migration 246 must never dual-write the table with the workspace.
-- A later removal migration may drop content_pipeline only after all of these
-- observable exit gates are true:
--   1. every active user_private row has a legacy_pipeline binding;
--   2. compatibility-route/client telemetry is zero for the agreed window;
--   3. every metadata_only legacy binding with scripts, source references,
--      performance, stage history, or publication evidence has verified
--      canonical artifact/lineage parity;
--   4. artifact-chain, export/deletion, dashboard, and agent reads use
--      workspace item/artifact/revision identifiers;
--   5. exact-snapshot rollback is no longer required by release policy.

CREATE TABLE IF NOT EXISTS content_workspace_ingress_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  owner_user_id INTEGER NOT NULL CHECK (owner_user_id > 0),
  source_kind TEXT NOT NULL
    CHECK (source_kind IN ('legacy_pipeline', 'content_agency_package')),
  source_id TEXT NOT NULL CHECK (length(trim(source_id)) BETWEEN 1 AND 240),
  source_hash TEXT
    CHECK (
      source_hash IS NULL
      OR (
        length(source_hash) = 64
        AND source_hash = lower(source_hash)
        AND source_hash NOT GLOB '*[^0-9a-f]*'
      )
    ),
  item_id INTEGER NOT NULL,
  artifact_id INTEGER,
  revision_id INTEGER,
  content_parity_status TEXT NOT NULL DEFAULT 'metadata_only'
    CHECK (content_parity_status IN ('metadata_only', 'artifact_pinned')),
  ingress_origin TEXT NOT NULL
    CHECK (ingress_origin IN ('legacy_pipeline_backfill', 'content_agency_handoff')),
  schema_version TEXT NOT NULL DEFAULT 'content-workspace-ingress-v1'
    CHECK (schema_version = 'content-workspace-ingress-v1'),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, owner_user_id, source_kind, source_id),
  FOREIGN KEY (item_id, tenant_id, owner_user_id)
    REFERENCES content_domain_objects(id, tenant_id, owner_user_id)
    ON DELETE CASCADE,
  FOREIGN KEY (artifact_id, tenant_id, owner_user_id)
    REFERENCES content_artifacts(id, tenant_id, owner_user_id)
    ON DELETE CASCADE,
  FOREIGN KEY (revision_id) REFERENCES content_revisions(id) ON DELETE CASCADE,
  CHECK (
    (artifact_id IS NULL AND revision_id IS NULL)
    OR artifact_id IS NOT NULL
  ),
  CHECK (
    content_parity_status <> 'artifact_pinned'
    OR (artifact_id IS NOT NULL AND revision_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_content_workspace_ingress_item
  ON content_workspace_ingress_bindings(
    tenant_id,
    owner_user_id,
    item_id,
    source_kind
  );

-- SQLite cannot express the complete revision -> artifact -> item scope chain
-- as one declarative foreign key, so enforce it on every binding write.
CREATE TRIGGER IF NOT EXISTS trg_content_workspace_ingress_scope_insert
BEFORE INSERT ON content_workspace_ingress_bindings
BEGIN
  SELECT RAISE(ABORT, 'content workspace ingress item scope mismatch')
    WHERE NOT EXISTS (
      SELECT 1
        FROM content_domain_objects AS item
       WHERE item.id = NEW.item_id
         AND item.tenant_id = NEW.tenant_id
         AND item.owner_user_id = NEW.owner_user_id
         AND item.object_type = 'content_item'
    );
  SELECT RAISE(ABORT, 'content workspace ingress artifact scope mismatch')
    WHERE NEW.artifact_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
        FROM content_artifacts AS artifact
       WHERE artifact.id = NEW.artifact_id
         AND artifact.item_id = NEW.item_id
         AND artifact.tenant_id = NEW.tenant_id
         AND artifact.owner_user_id = NEW.owner_user_id
    );
  SELECT RAISE(ABORT, 'content workspace ingress revision scope mismatch')
    WHERE NEW.revision_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
        FROM content_revisions AS revision
       WHERE revision.id = NEW.revision_id
         AND revision.artifact_id = NEW.artifact_id
         AND revision.tenant_id = NEW.tenant_id
         AND revision.owner_user_id = NEW.owner_user_id
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_content_workspace_ingress_scope_update
BEFORE UPDATE OF
  tenant_id,
  owner_user_id,
  source_kind,
  source_id,
  item_id,
  artifact_id,
  revision_id
ON content_workspace_ingress_bindings
BEGIN
  SELECT RAISE(ABORT, 'content workspace ingress identity is immutable')
    WHERE NEW.tenant_id <> OLD.tenant_id
      OR NEW.owner_user_id <> OLD.owner_user_id
      OR NEW.source_kind <> OLD.source_kind
      OR NEW.source_id <> OLD.source_id
      OR NEW.item_id <> OLD.item_id;
  SELECT RAISE(ABORT, 'content workspace ingress artifact is immutable once pinned')
    WHERE OLD.artifact_id IS NOT NULL AND NEW.artifact_id IS NOT OLD.artifact_id;
  SELECT RAISE(ABORT, 'content workspace ingress revision is immutable once pinned')
    WHERE OLD.revision_id IS NOT NULL AND NEW.revision_id IS NOT OLD.revision_id;
  SELECT RAISE(ABORT, 'content workspace ingress artifact scope mismatch')
    WHERE NEW.artifact_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
        FROM content_artifacts AS artifact
       WHERE artifact.id = NEW.artifact_id
         AND artifact.item_id = NEW.item_id
         AND artifact.tenant_id = NEW.tenant_id
         AND artifact.owner_user_id = NEW.owner_user_id
    );
  SELECT RAISE(ABORT, 'content workspace ingress revision scope mismatch')
    WHERE NEW.revision_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
        FROM content_revisions AS revision
       WHERE revision.id = NEW.revision_id
         AND revision.artifact_id = NEW.artifact_id
         AND revision.tenant_id = NEW.tenant_id
         AND revision.owner_user_id = NEW.owner_user_id
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_content_workspace_ingress_parity_update
BEFORE UPDATE OF content_parity_status ON content_workspace_ingress_bindings
WHEN NEW.content_parity_status <> OLD.content_parity_status
BEGIN
  SELECT RAISE(ABORT, 'content workspace ingress parity transition is invalid')
    WHERE OLD.content_parity_status <> 'metadata_only'
      OR NEW.content_parity_status <> 'artifact_pinned'
      OR NEW.artifact_id IS NULL
      OR NEW.revision_id IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS trg_content_workspace_ingress_hash_immutable
BEFORE UPDATE OF source_hash ON content_workspace_ingress_bindings
WHEN OLD.source_hash IS NOT NULL AND NEW.source_hash IS NOT OLD.source_hash
BEGIN
  SELECT RAISE(ABORT, 'content workspace ingress hash is immutable once pinned');
END;

-- Preserve only active, private, canonically-owned legacy inventory. Global,
-- quarantined, deleted, and superseded rows remain in the rollback table and
-- are not surfaced as another user's workspace data.
INSERT INTO content_domain_objects (
  tenant_id,
  owner_user_id,
  visibility_scope,
  scope_status,
  object_type,
  lifecycle_state,
  title,
  summary,
  platform_id,
  format_id,
  source_ids_json,
  ontology_metadata_json,
  ontology_schema_version,
  editorial_state,
  approval_state,
  review_required,
  review_reason_codes_json,
  artifact_phase,
  production_state,
  workspace_priority,
  next_action_json,
  is_favorite,
  workspace_schema_version,
  created_by,
  updated_by,
  audit_metadata_json,
  created_at,
  updated_at
)
SELECT
  pipeline.tenant_id,
  pipeline.owner_user_id,
  'user_private',
  'active',
  'content_item',
  CASE lower(COALESCE(pipeline.stage, ''))
    WHEN 'published' THEN 'review'
    WHEN 'review' THEN 'review'
    ELSE 'active'
  END,
  substr(trim(pipeline.topic_title), 1, 240),
  CASE
    WHEN pipeline.niche IS NULL OR trim(pipeline.niche) = '' THEN NULL
    ELSE substr(trim(pipeline.niche), 1, 20000)
  END,
  pipeline.platform_id,
  pipeline.format_id,
  CASE
    WHEN pipeline.source_agency_package_id IS NULL THEN '[]'
    ELSE json_array(pipeline.source_agency_package_id)
  END,
  json_object(
    'migration', 'content_pipeline_246',
    'legacyPipelineId', pipeline.id,
    'legacyStage', COALESCE(pipeline.stage, 'unknown'),
    'contentParity', 'metadata_only',
    'approvalEvidence', 'not_reconstructed',
    'publicationEvidence', 'unverified_legacy_claim'
  ),
  'content-ontology-v1',
  CASE lower(COALESCE(pipeline.stage, ''))
    WHEN 'published' THEN 'review'
    WHEN 'review' THEN 'review'
    ELSE 'idea'
  END,
  CASE lower(COALESCE(pipeline.stage, ''))
    WHEN 'published' THEN 'required'
    WHEN 'review' THEN 'required'
    ELSE 'not_required'
  END,
  CASE WHEN lower(COALESCE(pipeline.stage, '')) IN ('published', 'review') THEN 1 ELSE 0 END,
  CASE
    WHEN lower(COALESCE(pipeline.stage, '')) = 'published'
      THEN '["legacy_publication_claim_requires_verification","legacy_content_parity_pending"]'
    WHEN lower(COALESCE(pipeline.stage, '')) = 'review'
      THEN '["legacy_pipeline_review_requires_canonical_revision","legacy_content_parity_pending"]'
    ELSE '["legacy_content_parity_pending"]'
  END,
  'idea',
  CASE lower(COALESCE(pipeline.stage, ''))
    WHEN 'published' THEN 'review'
    WHEN 'review' THEN 'review'
    ELSE 'active'
  END,
  3,
  '{}',
  0,
  'content-workspace-v1',
  pipeline.owner_user_id,
  pipeline.owner_user_id,
  json_object(
    'migration', 'content_pipeline_246',
    'legacyPipelineId', pipeline.id,
    'legacyStage', COALESCE(pipeline.stage, 'unknown'),
    'legacyScopeStatus', pipeline.scope_status,
    'contentParity', 'metadata_only',
    'approvalEvidence', 'not_reconstructed',
    'publicationEvidence', 'unverified_legacy_claim',
    'legacyStageHistory', COALESCE(pipeline.stage_history, '[]'),
    'legacyScriptPath', pipeline.script_path,
    'legacyDriveUrl', pipeline.drive_url,
    'legacyYoutubeVideoId', pipeline.youtube_video_id,
    'legacyPublishedUrl', pipeline.published_url,
    'legacyPublishedAt', pipeline.published_at,
    'requiresLinkedScriptImport', CASE WHEN EXISTS (
      SELECT 1 FROM content_scripts AS script
       WHERE script.pipeline_id = pipeline.id
         AND script.tenant_id = pipeline.tenant_id
         AND script.owner_user_id = pipeline.owner_user_id
    ) THEN 1 ELSE 0 END,
    'requiresPerformanceImport', CASE WHEN EXISTS (
      SELECT 1 FROM content_performance AS performance
       WHERE performance.pipeline_id = pipeline.id
         AND performance.tenant_id = pipeline.tenant_id
         AND performance.owner_user_id = pipeline.owner_user_id
    ) THEN 1 ELSE 0 END
  ),
  COALESCE(pipeline.created_at, datetime('now')),
  COALESCE(pipeline.updated_at, pipeline.created_at, datetime('now'))
FROM content_pipeline AS pipeline
WHERE pipeline.tenant_id IS NOT NULL
  AND pipeline.tenant_id > 0
  AND pipeline.owner_user_id IS NOT NULL
  AND pipeline.owner_user_id > 0
  AND pipeline.visibility_scope = 'user_private'
  AND pipeline.scope_status = 'active'
  AND trim(COALESCE(pipeline.topic_title, '')) <> ''
  AND NOT EXISTS (
    SELECT 1
      FROM content_workspace_ingress_bindings AS binding
     WHERE binding.tenant_id = pipeline.tenant_id
       AND binding.owner_user_id = pipeline.owner_user_id
       AND binding.source_kind = 'legacy_pipeline'
       AND binding.source_id = CAST(pipeline.id AS TEXT)
  )
  AND NOT EXISTS (
    SELECT 1
      FROM content_domain_objects AS existing
     WHERE existing.tenant_id = pipeline.tenant_id
       AND existing.owner_user_id = pipeline.owner_user_id
       AND existing.object_type = 'content_item'
       AND json_extract(existing.audit_metadata_json, '$.migration') = 'content_pipeline_246'
       AND json_extract(existing.audit_metadata_json, '$.legacyPipelineId') = pipeline.id
  );

INSERT OR IGNORE INTO content_workspace_ingress_bindings (
  tenant_id,
  owner_user_id,
  source_kind,
  source_id,
  source_hash,
  item_id,
  content_parity_status,
  ingress_origin
)
SELECT
  pipeline.tenant_id,
  pipeline.owner_user_id,
  'legacy_pipeline',
  CAST(pipeline.id AS TEXT),
  NULL,
  item.id,
  'metadata_only',
  'legacy_pipeline_backfill'
FROM content_pipeline AS pipeline
JOIN content_domain_objects AS item
  ON item.tenant_id = pipeline.tenant_id
 AND item.owner_user_id = pipeline.owner_user_id
 AND item.object_type = 'content_item'
 AND json_extract(item.audit_metadata_json, '$.migration') = 'content_pipeline_246'
 AND json_extract(item.audit_metadata_json, '$.legacyPipelineId') = pipeline.id
WHERE pipeline.tenant_id > 0
  AND pipeline.owner_user_id > 0
  AND pipeline.visibility_scope = 'user_private'
  AND pipeline.scope_status = 'active';

-- A package source may point at the same canonical item as its legacy row.
-- This lets the first post-migration replay attach the immutable package
-- artifact without creating another item or mutating content_pipeline.
INSERT OR IGNORE INTO content_workspace_ingress_bindings (
  tenant_id,
  owner_user_id,
  source_kind,
  source_id,
  source_hash,
  item_id,
  content_parity_status,
  ingress_origin
)
SELECT
  pipeline.tenant_id,
  pipeline.owner_user_id,
  'content_agency_package',
  pipeline.source_agency_package_id,
  CASE
    WHEN length(trim(COALESCE(pipeline.source_agency_package_hash, ''))) = 64
      AND lower(trim(pipeline.source_agency_package_hash)) NOT GLOB '*[^0-9a-f]*'
      THEN lower(trim(pipeline.source_agency_package_hash))
    ELSE NULL
  END,
  legacy_binding.item_id,
  'metadata_only',
  'legacy_pipeline_backfill'
FROM content_pipeline AS pipeline
JOIN content_workspace_ingress_bindings AS legacy_binding
  ON legacy_binding.tenant_id = pipeline.tenant_id
 AND legacy_binding.owner_user_id = pipeline.owner_user_id
 AND legacy_binding.source_kind = 'legacy_pipeline'
 AND legacy_binding.source_id = CAST(pipeline.id AS TEXT)
WHERE pipeline.source_agency_package_id IS NOT NULL
  AND trim(pipeline.source_agency_package_id) <> ''
  AND pipeline.scope_status = 'active';

INSERT INTO content_workflow_events (
  tenant_id,
  owner_user_id,
  visibility_scope,
  scope_status,
  object_type,
  object_id,
  action,
  from_state,
  to_state,
  approval_state,
  review_required,
  reason_codes_json,
  actor_user_id,
  metadata_json,
  created_at
)
SELECT
  binding.tenant_id,
  binding.owner_user_id,
  'user_private',
  'active',
  'content_item',
  CAST(binding.item_id AS TEXT),
  'legacy_pipeline_migrated',
  'legacy_pipeline',
  item.production_state,
  CASE WHEN item.production_state = 'review' THEN 'required' ELSE 'not_required' END,
  CASE WHEN item.production_state = 'review' THEN 1 ELSE 0 END,
  '["legacy_pipeline_import"]',
  binding.owner_user_id,
  json_object(
    'sourceKind', 'legacy_pipeline',
    'sourceId', binding.source_id,
    'ingressSchemaVersion', binding.schema_version
  ),
  item.created_at
FROM content_workspace_ingress_bindings AS binding
JOIN content_domain_objects AS item
  ON item.id = binding.item_id
 AND item.tenant_id = binding.tenant_id
 AND item.owner_user_id = binding.owner_user_id
WHERE binding.source_kind = 'legacy_pipeline'
  AND NOT EXISTS (
    SELECT 1
      FROM content_workflow_events AS event
     WHERE event.tenant_id = binding.tenant_id
       AND event.owner_user_id = binding.owner_user_id
       AND event.object_type = 'content_item'
       AND event.object_id = CAST(binding.item_id AS TEXT)
       AND event.action = 'legacy_pipeline_migrated'
  );

-- Prevent code-only downgrade and all post-cutover split-brain writes. DELETE
-- remains available for scoped account erasure; exact rollback restores the
-- predecessor database snapshot where these triggers do not exist.
CREATE TRIGGER IF NOT EXISTS trg_content_pipeline_legacy_insert_blocked
BEFORE INSERT ON content_pipeline
BEGIN
  SELECT RAISE(ABORT, 'content_pipeline is read-only after migration 246; use content workspace');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_pipeline_legacy_update_blocked
BEFORE UPDATE ON content_pipeline
BEGIN
  SELECT RAISE(ABORT, 'content_pipeline is read-only after migration 246; use content workspace');
END;
