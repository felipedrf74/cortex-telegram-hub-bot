-- Migration 252: preserve every eligible legacy content_scripts body in the
-- canonical Content workspace.
--
-- Migration 246 froze content_pipeline and created its scoped item bindings,
-- but deliberately left linked content_scripts as metadata-only legacy data.
-- This additive follow-up keeps 246's deployed history immutable while
-- completing lossless item -> script artifact -> revision parity. The legacy
-- user-scoped legacy rows remain a read-only compatibility source until their
-- readers migrate; ownerless system fixtures retain their existing isolated
-- ingress. Runtime readiness fails if any active private legacy body is not
-- pinned.

CREATE TABLE content_legacy_script_ingress_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  owner_user_id INTEGER NOT NULL CHECK (owner_user_id > 0),
  source_script_id INTEGER NOT NULL CHECK (source_script_id > 0),
  source_hash TEXT NOT NULL
    CHECK (
      length(source_hash) = 64
      AND source_hash = lower(source_hash)
      AND source_hash NOT GLOB '*[^0-9a-f]*'
    ),
  item_id INTEGER NOT NULL,
  artifact_id INTEGER NOT NULL,
  revision_id INTEGER NOT NULL,
  content_parity_status TEXT NOT NULL DEFAULT 'artifact_pinned'
    CHECK (content_parity_status = 'artifact_pinned'),
  schema_version TEXT NOT NULL DEFAULT 'content-legacy-script-ingress-v1'
    CHECK (schema_version = 'content-legacy-script-ingress-v1'),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, owner_user_id, source_script_id),
  FOREIGN KEY (item_id, tenant_id, owner_user_id)
    REFERENCES content_domain_objects(id, tenant_id, owner_user_id)
    ON DELETE CASCADE,
  FOREIGN KEY (artifact_id, tenant_id, owner_user_id)
    REFERENCES content_artifacts(id, tenant_id, owner_user_id)
    ON DELETE CASCADE,
  FOREIGN KEY (revision_id) REFERENCES content_revisions(id) ON DELETE CASCADE
);

CREATE INDEX idx_content_legacy_script_ingress_item
  ON content_legacy_script_ingress_bindings(
    tenant_id,
    owner_user_id,
    item_id,
    source_script_id
  );

CREATE TRIGGER trg_content_legacy_script_ingress_scope_insert
BEFORE INSERT ON content_legacy_script_ingress_bindings
BEGIN
  SELECT RAISE(ABORT, 'content legacy script ingress item scope mismatch')
    WHERE NOT EXISTS (
      SELECT 1
        FROM content_domain_objects AS item
       WHERE item.id = NEW.item_id
         AND item.tenant_id = NEW.tenant_id
         AND item.owner_user_id = NEW.owner_user_id
         AND item.object_type = 'content_item'
         AND item.visibility_scope = 'user_private'
    );
  SELECT RAISE(ABORT, 'content legacy script ingress artifact scope mismatch')
    WHERE NOT EXISTS (
      SELECT 1
        FROM content_artifacts AS artifact
       WHERE artifact.id = NEW.artifact_id
         AND artifact.item_id = NEW.item_id
         AND artifact.tenant_id = NEW.tenant_id
         AND artifact.owner_user_id = NEW.owner_user_id
    );
  SELECT RAISE(ABORT, 'content legacy script ingress revision scope mismatch')
    WHERE NOT EXISTS (
      SELECT 1
        FROM content_revisions AS revision
       WHERE revision.id = NEW.revision_id
         AND revision.artifact_id = NEW.artifact_id
         AND revision.tenant_id = NEW.tenant_id
         AND revision.owner_user_id = NEW.owner_user_id
    );
END;

CREATE TRIGGER trg_content_legacy_script_ingress_immutable
BEFORE UPDATE ON content_legacy_script_ingress_bindings
BEGIN
  SELECT RAISE(ABORT, 'content legacy script ingress is immutable');
END;

-- Scripts without a valid same-scope pipeline binding receive a standalone
-- workspace item. Cross-tenant pipeline identifiers never influence the item
-- selected for the script owner.
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
  script.tenant_id,
  script.owner_user_id,
  'user_private',
  'active',
  'content_item',
  'active',
  CASE
    WHEN trim(COALESCE(script.topic, ''), char(9) || char(10) || char(11) || char(12) || char(13) || char(32) || char(133) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288)) = ''
      THEN 'Untitled script'
    ELSE substr(trim(script.topic, char(9) || char(10) || char(11) || char(12) || char(13) || char(32) || char(133) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288)), 1, 240)
  END,
  CASE WHEN trim(COALESCE(script.niche, '')) = '' THEN NULL ELSE substr(trim(script.niche), 1, 20000) END,
  script.platform_id,
  COALESCE(NULLIF(trim(script.format_id), ''), NULLIF(trim(script.format), '')),
  '[]',
  json_object(
    'migration', 'content_legacy_script_252',
    'legacyScriptId', script.id,
    'legacyRawTopic', script.topic,
    'contentParity', 'artifact_pinned'
  ),
  'content-ontology-v1',
  'drafted',
  'not_required',
  0,
  '[]',
  'idea',
  'active',
  3,
  '{}',
  0,
  'content-workspace-v1',
  script.owner_user_id,
  script.owner_user_id,
  json_object(
    'migration', 'content_legacy_script_252',
    'legacyScriptId', script.id,
    'legacyPipelineId', script.pipeline_id,
    'legacyRawTopic', script.topic,
    'contentParity', 'artifact_pinned'
  ),
  COALESCE(script.created_at, datetime('now')),
  COALESCE(script.created_at, datetime('now'))
FROM content_scripts AS script
WHERE script.tenant_id > 0
  AND script.owner_user_id > 0
  AND script.visibility_scope = 'user_private'
  AND script.scope_status = 'active'
  AND trim(COALESCE(script.script_text, ''), char(9) || char(10) || char(11) || char(12) || char(13) || char(32) || char(133) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288)) <> ''
  AND NOT EXISTS (
    SELECT 1
      FROM content_workspace_ingress_bindings AS pipeline_binding
     WHERE pipeline_binding.tenant_id = script.tenant_id
       AND pipeline_binding.owner_user_id = script.owner_user_id
       AND pipeline_binding.source_kind = 'legacy_pipeline'
       AND pipeline_binding.source_id = CAST(script.pipeline_id AS TEXT)
  )
  AND NOT EXISTS (
    SELECT 1
      FROM content_domain_objects AS existing
     WHERE existing.tenant_id = script.tenant_id
       AND existing.owner_user_id = script.owner_user_id
       AND existing.object_type = 'content_item'
       AND json_extract(existing.audit_metadata_json, '$.migration') = 'content_legacy_script_252'
       AND json_extract(existing.audit_metadata_json, '$.legacyScriptId') = script.id
  );

-- Create one canonical script artifact per legacy body. Multiple historical
-- scripts on one pipeline are all preserved as separate immutable artifacts.
INSERT INTO content_artifacts (
  tenant_id,
  owner_user_id,
  visibility_scope,
  scope_status,
  item_id,
  artifact_type,
  title,
  platform_id,
  format_id,
  metadata_json,
  schema_version,
  created_by,
  updated_by,
  created_at,
  updated_at
)
SELECT
  script.tenant_id,
  script.owner_user_id,
  'user_private',
  'active',
  COALESCE(pipeline_binding.item_id, standalone.id),
  'script',
  CASE
    WHEN trim(COALESCE(script.topic, ''), char(9) || char(10) || char(11) || char(12) || char(13) || char(32) || char(133) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288)) = ''
      THEN 'Untitled script'
    ELSE substr(trim(script.topic, char(9) || char(10) || char(11) || char(12) || char(13) || char(32) || char(133) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288)), 1, 240)
  END,
  script.platform_id,
  COALESCE(NULLIF(trim(script.format_id), ''), NULLIF(trim(script.format), '')),
  json_object(
    'migration', 'content_legacy_script_252',
    'legacyScriptId', script.id,
    'legacyPipelineId', script.pipeline_id,
    'legacyRawTopic', script.topic,
    'captureOrigin', 'legacy_script_backfill',
    'sourceHash', nexus_sha256(script.script_text),
    'hook', script.hook,
    'titleOptions', CASE WHEN json_valid(script.title_options) THEN json(script.title_options) ELSE json_array() END,
    'sourcesUsed', CASE WHEN json_valid(script.sources_used) THEN json(script.sources_used) ELSE json_array() END,
    'hashtags', CASE WHEN json_valid(script.hashtags) THEN json(script.hashtags) ELSE json_array() END,
    'caption', script.caption,
    'cta', script.cta,
    'estimatedDuration', script.estimated_duration,
    'niche', script.niche,
    'generationDurationMs', script.generation_duration_ms
  ),
  'content-artifact-v1',
  script.owner_user_id,
  script.owner_user_id,
  COALESCE(script.created_at, datetime('now')),
  COALESCE(script.created_at, datetime('now'))
FROM content_scripts AS script
LEFT JOIN content_workspace_ingress_bindings AS pipeline_binding
  ON pipeline_binding.tenant_id = script.tenant_id
 AND pipeline_binding.owner_user_id = script.owner_user_id
 AND pipeline_binding.source_kind = 'legacy_pipeline'
 AND pipeline_binding.source_id = CAST(script.pipeline_id AS TEXT)
LEFT JOIN content_domain_objects AS standalone
  ON standalone.tenant_id = script.tenant_id
 AND standalone.owner_user_id = script.owner_user_id
 AND standalone.object_type = 'content_item'
 AND json_extract(standalone.audit_metadata_json, '$.migration') = 'content_legacy_script_252'
 AND json_extract(standalone.audit_metadata_json, '$.legacyScriptId') = script.id
WHERE script.tenant_id > 0
  AND script.owner_user_id > 0
  AND script.visibility_scope = 'user_private'
  AND script.scope_status = 'active'
  AND trim(COALESCE(script.script_text, ''), char(9) || char(10) || char(11) || char(12) || char(13) || char(32) || char(133) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288)) <> ''
  AND COALESCE(pipeline_binding.item_id, standalone.id) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
      FROM content_artifacts AS existing
     WHERE existing.tenant_id = script.tenant_id
       AND existing.owner_user_id = script.owner_user_id
       AND json_extract(existing.metadata_json, '$.migration') = 'content_legacy_script_252'
       AND json_extract(existing.metadata_json, '$.legacyScriptId') = script.id
  );

INSERT INTO content_revisions (
  tenant_id,
  owner_user_id,
  artifact_id,
  revision_number,
  parent_revision_id,
  restored_from_revision_id,
  content_format,
  content_text,
  structured_content_json,
  content_hash,
  change_summary,
  change_reason,
  actor_type,
  actor_id,
  provenance_json,
  schema_version,
  created_by,
  created_at
)
SELECT
  script.tenant_id,
  script.owner_user_id,
  artifact.id,
  1,
  NULL,
  NULL,
  'plain_text',
  script.script_text,
  NULL,
  nexus_plain_text_revision_hash(script.script_text),
  'Imported lossless legacy script body',
  'legacy_script_backfill',
  'import',
  'migration-252',
  json_object(
    'migration', 'content_legacy_script_252',
    'legacyScriptId', script.id,
    'legacyRawTopic', script.topic,
    'sourceHash', nexus_sha256(script.script_text)
  ),
  'content-revision-v1',
  script.owner_user_id,
  COALESCE(script.created_at, datetime('now'))
FROM content_scripts AS script
JOIN content_artifacts AS artifact
  ON artifact.tenant_id = script.tenant_id
 AND artifact.owner_user_id = script.owner_user_id
 AND json_extract(artifact.metadata_json, '$.migration') = 'content_legacy_script_252'
 AND json_extract(artifact.metadata_json, '$.legacyScriptId') = script.id
WHERE NOT EXISTS (
  SELECT 1 FROM content_revisions AS existing
   WHERE existing.artifact_id = artifact.id
);

UPDATE content_artifacts
   SET current_revision_id = (
         SELECT revision.id
           FROM content_revisions AS revision
          WHERE revision.artifact_id = content_artifacts.id
            AND revision.tenant_id = content_artifacts.tenant_id
            AND revision.owner_user_id = content_artifacts.owner_user_id
            AND revision.revision_number = 1
       ),
       revision_count = 1,
       updated_at = COALESCE(updated_at, datetime('now'))
 WHERE json_extract(metadata_json, '$.migration') = 'content_legacy_script_252'
   AND current_revision_id IS NULL;

INSERT INTO content_legacy_script_ingress_bindings (
  tenant_id,
  owner_user_id,
  source_script_id,
  source_hash,
  item_id,
  artifact_id,
  revision_id
)
SELECT
  script.tenant_id,
  script.owner_user_id,
  script.id,
  nexus_sha256(script.script_text),
  artifact.item_id,
  artifact.id,
  revision.id
FROM content_scripts AS script
JOIN content_artifacts AS artifact
  ON artifact.tenant_id = script.tenant_id
 AND artifact.owner_user_id = script.owner_user_id
 AND json_extract(artifact.metadata_json, '$.migration') = 'content_legacy_script_252'
 AND json_extract(artifact.metadata_json, '$.legacyScriptId') = script.id
JOIN content_revisions AS revision
  ON revision.id = artifact.current_revision_id
 AND revision.artifact_id = artifact.id
 AND revision.tenant_id = artifact.tenant_id
 AND revision.owner_user_id = artifact.owner_user_id;

-- Select the newest scoped legacy script as the item's current artifact, but
-- retain every older script artifact for compare/export/recovery.
UPDATE content_domain_objects
   SET current_artifact_id = (
         SELECT binding.artifact_id
           FROM content_legacy_script_ingress_bindings AS binding
           JOIN content_scripts AS script ON script.id = binding.source_script_id
          WHERE binding.tenant_id = content_domain_objects.tenant_id
            AND binding.owner_user_id = content_domain_objects.owner_user_id
            AND binding.item_id = content_domain_objects.id
          ORDER BY datetime(script.created_at) DESC, script.id DESC
          LIMIT 1
       ),
       artifact_phase = 'draft',
       production_state = CASE
         WHEN production_state IN ('approved', 'scheduled', 'published') THEN 'review'
         ELSE production_state
       END,
       lifecycle_state = CASE
         WHEN production_state IN ('approved', 'scheduled', 'published') THEN 'review'
         ELSE lifecycle_state
       END,
       editorial_state = CASE
         WHEN production_state = 'review' THEN 'reviewed'
         ELSE 'drafted'
       END,
       approval_state = CASE
         WHEN production_state IN ('approved', 'scheduled', 'published') THEN 'required'
         ELSE approval_state
       END,
       review_required = CASE
         WHEN production_state IN ('approved', 'scheduled', 'published') THEN 1
         ELSE review_required
       END,
       review_reason_codes_json = CASE
         WHEN production_state IN ('approved', 'scheduled', 'published')
           THEN '["legacy_script_import_invalidated_approval"]'
         ELSE review_reason_codes_json
       END,
       approved_by = CASE
         WHEN production_state IN ('approved', 'scheduled', 'published') THEN NULL
         ELSE approved_by
       END,
       approved_at = CASE
         WHEN production_state IN ('approved', 'scheduled', 'published') THEN NULL
         ELSE approved_at
       END,
       ontology_metadata_json = json_set(
         COALESCE(ontology_metadata_json, '{}'),
         '$.contentParity',
         'artifact_pinned'
       ),
       audit_metadata_json = json_set(
         COALESCE(audit_metadata_json, '{}'),
         '$.contentParity',
         'artifact_pinned'
       ),
       workflow_version = workflow_version + 1,
       updated_at = datetime('now')
 WHERE EXISTS (
   SELECT 1
     FROM content_legacy_script_ingress_bindings AS binding
    WHERE binding.tenant_id = content_domain_objects.tenant_id
      AND binding.owner_user_id = content_domain_objects.owner_user_id
      AND binding.item_id = content_domain_objects.id
 );

-- Pin the old pipeline alias to the same newest script artifact/revision. This
-- closes split-brain reads while retaining the immutable legacy identifier.
UPDATE content_workspace_ingress_bindings
   SET source_hash = (
         SELECT script_binding.source_hash
           FROM content_legacy_script_ingress_bindings AS script_binding
           JOIN content_scripts AS script ON script.id = script_binding.source_script_id
          WHERE script_binding.tenant_id = content_workspace_ingress_bindings.tenant_id
            AND script_binding.owner_user_id = content_workspace_ingress_bindings.owner_user_id
            AND script_binding.item_id = content_workspace_ingress_bindings.item_id
            AND CAST(script.pipeline_id AS TEXT) = content_workspace_ingress_bindings.source_id
          ORDER BY datetime(script.created_at) DESC, script.id DESC
          LIMIT 1
       ),
       artifact_id = (
         SELECT script_binding.artifact_id
           FROM content_legacy_script_ingress_bindings AS script_binding
           JOIN content_scripts AS script ON script.id = script_binding.source_script_id
          WHERE script_binding.tenant_id = content_workspace_ingress_bindings.tenant_id
            AND script_binding.owner_user_id = content_workspace_ingress_bindings.owner_user_id
            AND script_binding.item_id = content_workspace_ingress_bindings.item_id
            AND CAST(script.pipeline_id AS TEXT) = content_workspace_ingress_bindings.source_id
          ORDER BY datetime(script.created_at) DESC, script.id DESC
          LIMIT 1
       ),
       revision_id = (
         SELECT script_binding.revision_id
           FROM content_legacy_script_ingress_bindings AS script_binding
           JOIN content_scripts AS script ON script.id = script_binding.source_script_id
          WHERE script_binding.tenant_id = content_workspace_ingress_bindings.tenant_id
            AND script_binding.owner_user_id = content_workspace_ingress_bindings.owner_user_id
            AND script_binding.item_id = content_workspace_ingress_bindings.item_id
            AND CAST(script.pipeline_id AS TEXT) = content_workspace_ingress_bindings.source_id
          ORDER BY datetime(script.created_at) DESC, script.id DESC
          LIMIT 1
       ),
       content_parity_status = 'artifact_pinned',
       updated_at = datetime('now')
 WHERE source_kind = 'legacy_pipeline'
   AND content_parity_status = 'metadata_only'
   AND EXISTS (
     SELECT 1
       FROM content_legacy_script_ingress_bindings AS script_binding
       JOIN content_scripts AS script ON script.id = script_binding.source_script_id
      WHERE script_binding.tenant_id = content_workspace_ingress_bindings.tenant_id
        AND script_binding.owner_user_id = content_workspace_ingress_bindings.owner_user_id
        AND script_binding.item_id = content_workspace_ingress_bindings.item_id
        AND CAST(script.pipeline_id AS TEXT) = content_workspace_ingress_bindings.source_id
   );

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
  'legacy_script_migrated',
  'legacy_script',
  item.production_state,
  item.approval_state,
  item.review_required,
  '["legacy_script_import"]',
  binding.owner_user_id,
  json_object(
    'sourceScriptId', binding.source_script_id,
    'artifactId', binding.artifact_id,
    'revisionId', binding.revision_id,
    'sourceHash', binding.source_hash,
    'schemaVersion', binding.schema_version
  ),
  item.updated_at
FROM content_legacy_script_ingress_bindings AS binding
JOIN content_domain_objects AS item
  ON item.id = binding.item_id
 AND item.tenant_id = binding.tenant_id
 AND item.owner_user_id = binding.owner_user_id;

-- Prevent an older binary or operational SQL from creating a second
-- user-scoped script root after parity. Ownerless system fixtures use zero
-- identifiers and remain available to the isolated system-only compatibility
-- path. DELETE deliberately remains available for scoped account erasure; the
-- canonical item/artifact/revision graph remains the durable user authority.
CREATE TRIGGER IF NOT EXISTS trg_content_scripts_legacy_user_insert_blocked
BEFORE INSERT ON content_scripts
WHEN COALESCE(NEW.user_id, 0) <> 0
  OR COALESCE(NEW.tenant_id, 0) <> 0
  OR COALESCE(NEW.owner_user_id, 0) <> 0
BEGIN
  SELECT RAISE(ABORT, 'content_scripts user scope is read-only after migration 252; use content workspace');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_scripts_legacy_user_update_blocked
BEFORE UPDATE ON content_scripts
WHEN COALESCE(OLD.user_id, 0) <> 0
  OR COALESCE(OLD.tenant_id, 0) <> 0
  OR COALESCE(OLD.owner_user_id, 0) <> 0
  OR COALESCE(NEW.user_id, 0) <> 0
  OR COALESCE(NEW.tenant_id, 0) <> 0
  OR COALESCE(NEW.owner_user_id, 0) <> 0
BEGIN
  SELECT RAISE(ABORT, 'content_scripts user scope is read-only after migration 252; use content workspace');
END;
