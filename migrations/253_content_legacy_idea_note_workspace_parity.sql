-- Migration 253: preserve the remaining legacy idea roots.
--
-- Before canonical workspace capture, chat and REST callers could persist an
-- idea in the generic notes table by setting domain = content_idea. Every
-- positive-user, nonblank source is copied byte-for-byte into one private
-- content item, idea-note artifact, and immutable revision. The legacy row is
-- retained as read-only source evidence. Ownerless and blank rows are not
-- assigned to a user or promoted into fake content; a hash-only quarantine
-- ledger records why each source was intentionally excluded.
--
-- The older saved_ideas root is cut over in the same transaction. Its scoped
-- tenant and owner identities stay independent, its title bytes become the
-- immutable idea revision, and its complete historical row becomes a hashed
-- binding snapshot. Unsupported scope or blank-title rows are quarantined
-- without deleting the source. Both alternate writers are frozen at the end.

CREATE TABLE IF NOT EXISTS content_legacy_idea_note_ingress_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  owner_user_id INTEGER NOT NULL CHECK (owner_user_id > 0),
  source_note_id INTEGER NOT NULL CHECK (source_note_id > 0),
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
  schema_version TEXT NOT NULL DEFAULT 'content-legacy-idea-note-ingress-v1'
    CHECK (schema_version = 'content-legacy-idea-note-ingress-v1'),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (tenant_id = owner_user_id),
  UNIQUE(tenant_id, owner_user_id, source_note_id),
  UNIQUE(tenant_id, owner_user_id, item_id),
  UNIQUE(tenant_id, owner_user_id, artifact_id),
  UNIQUE(tenant_id, owner_user_id, revision_id),
  FOREIGN KEY (item_id, tenant_id, owner_user_id)
    REFERENCES content_domain_objects(id, tenant_id, owner_user_id)
    ON DELETE CASCADE,
  FOREIGN KEY (artifact_id, tenant_id, owner_user_id)
    REFERENCES content_artifacts(id, tenant_id, owner_user_id)
    ON DELETE CASCADE,
  FOREIGN KEY (revision_id) REFERENCES content_revisions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_content_legacy_idea_note_ingress_source
  ON content_legacy_idea_note_ingress_bindings(
    tenant_id,
    owner_user_id,
    source_note_id,
    item_id
  );

CREATE TABLE IF NOT EXISTS content_legacy_idea_note_quarantine (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_note_id INTEGER NOT NULL CHECK (source_note_id > 0),
  owner_user_id INTEGER NOT NULL CHECK (owner_user_id >= 0),
  source_hash TEXT NOT NULL
    CHECK (
      length(source_hash) = 64
      AND source_hash = lower(source_hash)
      AND source_hash NOT GLOB '*[^0-9a-f]*'
    ),
  reason_code TEXT NOT NULL
    CHECK (reason_code IN (
      'ownerless_user',
      'blank_body',
      'ownerless_and_blank_body'
    )),
  metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  schema_version TEXT NOT NULL DEFAULT 'content-legacy-idea-note-quarantine-v1'
    CHECK (schema_version = 'content-legacy-idea-note-quarantine-v1'),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_note_id)
);

CREATE INDEX IF NOT EXISTS idx_content_legacy_idea_note_quarantine_owner
  ON content_legacy_idea_note_quarantine(owner_user_id, reason_code, source_note_id);

CREATE TABLE IF NOT EXISTS content_legacy_saved_idea_ingress_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  owner_user_id INTEGER NOT NULL CHECK (owner_user_id > 0),
  source_saved_idea_id INTEGER NOT NULL CHECK (source_saved_idea_id > 0),
  source_hash TEXT NOT NULL
    CHECK (
      length(source_hash) = 64
      AND source_hash = lower(source_hash)
      AND source_hash NOT GLOB '*[^0-9a-f]*'
    ),
  source_snapshot_json TEXT NOT NULL
    CHECK (json_valid(source_snapshot_json) AND json_type(source_snapshot_json) = 'object'),
  item_id INTEGER NOT NULL,
  artifact_id INTEGER NOT NULL,
  revision_id INTEGER NOT NULL,
  content_parity_status TEXT NOT NULL DEFAULT 'artifact_pinned'
    CHECK (content_parity_status = 'artifact_pinned'),
  schema_version TEXT NOT NULL DEFAULT 'content-legacy-saved-idea-ingress-v1'
    CHECK (schema_version = 'content-legacy-saved-idea-ingress-v1'),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, owner_user_id, source_saved_idea_id),
  UNIQUE(tenant_id, owner_user_id, item_id),
  UNIQUE(tenant_id, owner_user_id, artifact_id),
  UNIQUE(tenant_id, owner_user_id, revision_id),
  FOREIGN KEY (item_id, tenant_id, owner_user_id)
    REFERENCES content_domain_objects(id, tenant_id, owner_user_id)
    ON DELETE CASCADE,
  FOREIGN KEY (artifact_id, tenant_id, owner_user_id)
    REFERENCES content_artifacts(id, tenant_id, owner_user_id)
    ON DELETE CASCADE,
  FOREIGN KEY (revision_id) REFERENCES content_revisions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_content_legacy_saved_idea_ingress_source
  ON content_legacy_saved_idea_ingress_bindings(
    tenant_id,
    owner_user_id,
    source_saved_idea_id,
    item_id
  );

CREATE TABLE IF NOT EXISTS content_legacy_saved_idea_quarantine (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_saved_idea_id INTEGER NOT NULL CHECK (source_saved_idea_id > 0),
  observed_user_id INTEGER NOT NULL CHECK (observed_user_id >= 0),
  observed_tenant_id INTEGER NOT NULL CHECK (observed_tenant_id >= 0),
  observed_owner_user_id INTEGER NOT NULL CHECK (observed_owner_user_id >= 0),
  source_hash TEXT NOT NULL
    CHECK (
      length(source_hash) = 64
      AND source_hash = lower(source_hash)
      AND source_hash NOT GLOB '*[^0-9a-f]*'
    ),
  reason_code TEXT NOT NULL
    CHECK (reason_code IN (
      'ownerless_scope',
      'nonprivate_visibility',
      'inactive_scope',
      'blank_title'
    )),
  metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  schema_version TEXT NOT NULL DEFAULT 'content-legacy-saved-idea-quarantine-v1'
    CHECK (schema_version = 'content-legacy-saved-idea-quarantine-v1'),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_saved_idea_id),
  FOREIGN KEY (source_saved_idea_id) REFERENCES saved_ideas(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_content_legacy_saved_idea_quarantine_scope
  ON content_legacy_saved_idea_quarantine(
    observed_tenant_id,
    observed_owner_user_id,
    reason_code,
    source_saved_idea_id
  );

-- One internal source-state view defines scope fallback and exact snapshot
-- hashing for the backfill, insert guard, and ongoing readiness view. Explicit
-- tenant/owner identity wins; historical post-089 rows with both columns NULL
-- fall back to their positive user_id exactly as existing scoped reads did.
DROP VIEW IF EXISTS content_legacy_saved_idea_source_state;
CREATE VIEW content_legacy_saved_idea_source_state AS
WITH normalized AS (
  SELECT idea.*,
         COALESCE(NULLIF(idea.tenant_id, 0), idea.user_id, 0) AS resolved_tenant_id,
         COALESCE(NULLIF(idea.owner_user_id, 0), idea.user_id, 0) AS resolved_owner_user_id,
         COALESCE(idea.visibility_scope, CASE WHEN idea.user_id > 0 THEN 'user_private' ELSE 'platform_internal' END)
           AS resolved_visibility_scope,
         COALESCE(idea.scope_status, CASE WHEN idea.user_id > 0 THEN 'active' ELSE 'quarantined' END)
           AS resolved_scope_status
    FROM saved_ideas AS idea
),
snapshots AS (
  SELECT normalized.*,
         json_object(
           'id', normalized.id,
           'title', normalized.title,
           'sourceDate', normalized.source_date,
           'status', normalized.status,
           'createdAt', normalized.created_at,
           'source', normalized.source,
           'score', normalized.score,
           'workflowEligible', normalized.workflow_eligible,
           'angleTag', normalized.angle_tag,
           'niche', normalized.niche,
           'hookIdea', normalized.hook_idea,
           'whyNow', normalized.why_now,
           'userId', normalized.user_id,
           'tenantId', normalized.tenant_id,
           'ownerUserId', normalized.owner_user_id,
           'visibilityScope', normalized.visibility_scope,
           'lifecycleState', normalized.lifecycle_state,
           'scopeStatus', normalized.scope_status,
           'createdBy', normalized.created_by,
           'updatedBy', normalized.updated_by,
           'auditMetadataRaw', normalized.audit_metadata_json,
           'contentObjectType', normalized.content_object_type,
           'platformId', normalized.platform_id,
           'formatId', normalized.format_id,
           'pillarId', normalized.pillar_id,
           'audienceSegmentId', normalized.audience_segment_id,
           'campaignId', normalized.campaign_id,
           'seriesId', normalized.series_id,
           'sourceIdsRaw', normalized.source_ids_json,
           'ontologyMetadataRaw', normalized.ontology_metadata_json,
           'ontologySchemaVersion', normalized.ontology_schema_version
         ) AS source_snapshot_json
    FROM normalized
)
SELECT snapshots.*,
       nexus_sha256(snapshots.source_snapshot_json) AS source_hash,
       CASE
         WHEN snapshots.resolved_tenant_id <= 0
           OR snapshots.resolved_owner_user_id <= 0
           THEN 'ownerless_scope'
         WHEN snapshots.resolved_visibility_scope <> 'user_private'
           THEN 'nonprivate_visibility'
         WHEN snapshots.resolved_scope_status <> 'active'
           THEN 'inactive_scope'
         WHEN trim(
                COALESCE(snapshots.title, ''),
                char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
                || char(133) || char(160) || char(5760)
                || char(8192) || char(8193) || char(8194) || char(8195)
                || char(8196) || char(8197) || char(8198) || char(8199)
                || char(8200) || char(8201) || char(8202) || char(8232)
                || char(8233) || char(8239) || char(8287) || char(12288)
              ) = ''
           THEN 'blank_title'
         ELSE NULL
       END AS ineligibility_reason,
       CASE
         WHEN snapshots.resolved_tenant_id > 0
          AND snapshots.resolved_owner_user_id > 0
          AND snapshots.resolved_visibility_scope = 'user_private'
          AND snapshots.resolved_scope_status = 'active'
          AND trim(
                COALESCE(snapshots.title, ''),
                char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
                || char(133) || char(160) || char(5760)
                || char(8192) || char(8193) || char(8194) || char(8195)
                || char(8196) || char(8197) || char(8198) || char(8199)
                || char(8200) || char(8201) || char(8202) || char(8232)
                || char(8233) || char(8239) || char(8287) || char(12288)
              ) <> ''
           THEN 1
         ELSE 0
       END AS is_eligible
  FROM snapshots;

DROP TRIGGER IF EXISTS trg_content_legacy_saved_idea_ingress_scope_insert;
CREATE TRIGGER trg_content_legacy_saved_idea_ingress_scope_insert
BEFORE INSERT ON content_legacy_saved_idea_ingress_bindings
BEGIN
  SELECT RAISE(ABORT, 'content legacy saved idea source scope, snapshot, or hash mismatch')
    WHERE NOT EXISTS (
      SELECT 1
        FROM content_legacy_saved_idea_source_state AS source
       WHERE source.id = NEW.source_saved_idea_id
         AND source.is_eligible = 1
         AND source.resolved_tenant_id = NEW.tenant_id
         AND source.resolved_owner_user_id = NEW.owner_user_id
         AND source.source_hash = NEW.source_hash
         AND source.source_snapshot_json = NEW.source_snapshot_json
    );

  SELECT RAISE(ABORT, 'content legacy saved idea item scope mismatch')
    WHERE NOT EXISTS (
      SELECT 1
        FROM content_domain_objects AS item
       WHERE item.id = NEW.item_id
         AND item.tenant_id = NEW.tenant_id
         AND item.owner_user_id = NEW.owner_user_id
         AND item.object_type = 'content_item'
         AND item.visibility_scope = 'user_private'
         AND item.current_artifact_id = NEW.artifact_id
    );

  SELECT RAISE(ABORT, 'content legacy saved idea artifact scope mismatch')
    WHERE NOT EXISTS (
      SELECT 1
        FROM content_artifacts AS artifact
       WHERE artifact.id = NEW.artifact_id
         AND artifact.item_id = NEW.item_id
         AND artifact.tenant_id = NEW.tenant_id
         AND artifact.owner_user_id = NEW.owner_user_id
         AND artifact.artifact_type = 'idea_note'
         AND artifact.current_revision_id = NEW.revision_id
         AND artifact.revision_count = 1
    );

  SELECT RAISE(ABORT, 'content legacy saved idea revision scope or bytes mismatch')
    WHERE NOT EXISTS (
      SELECT 1
        FROM content_revisions AS revision
        JOIN content_legacy_saved_idea_source_state AS source
          ON source.id = NEW.source_saved_idea_id
       WHERE revision.id = NEW.revision_id
         AND revision.artifact_id = NEW.artifact_id
         AND revision.tenant_id = NEW.tenant_id
         AND revision.owner_user_id = NEW.owner_user_id
         AND revision.revision_number = 1
         AND revision.content_format = 'plain_text'
         AND revision.content_text = source.title
         AND revision.content_hash = nexus_plain_text_revision_hash(source.title)
    );
END;

DROP TRIGGER IF EXISTS trg_content_legacy_saved_idea_ingress_immutable_update;
CREATE TRIGGER trg_content_legacy_saved_idea_ingress_immutable_update
BEFORE UPDATE ON content_legacy_saved_idea_ingress_bindings
BEGIN
  SELECT RAISE(ABORT, 'content legacy saved idea ingress binding is immutable');
END;

DROP TRIGGER IF EXISTS trg_content_legacy_saved_idea_ingress_immutable_delete;
CREATE TRIGGER trg_content_legacy_saved_idea_ingress_immutable_delete
BEFORE DELETE ON content_legacy_saved_idea_ingress_bindings
WHEN EXISTS (
       SELECT 1 FROM content_domain_objects AS item WHERE item.id = OLD.item_id
     )
 AND NOT EXISTS (
       SELECT 1
         FROM training_revision_erasure_authorizations AS authorization
        WHERE authorization.subject_user_id = OLD.owner_user_id
          AND authorization.reason IN ('ACCOUNT_DELETION', 'LEGAL_ERASURE')
          AND datetime(authorization.expires_at) >= datetime('now')
     )
BEGIN
  SELECT RAISE(ABORT, 'content legacy saved idea ingress binding is immutable');
END;

DROP TRIGGER IF EXISTS trg_content_legacy_saved_idea_quarantine_immutable;
CREATE TRIGGER trg_content_legacy_saved_idea_quarantine_immutable
BEFORE UPDATE ON content_legacy_saved_idea_quarantine
BEGIN
  SELECT RAISE(ABORT, 'content legacy saved idea quarantine is immutable');
END;

DROP TRIGGER IF EXISTS trg_content_legacy_idea_note_ingress_scope_insert;
CREATE TRIGGER trg_content_legacy_idea_note_ingress_scope_insert
BEFORE INSERT ON content_legacy_idea_note_ingress_bindings
BEGIN
  SELECT RAISE(ABORT, 'content legacy idea note source scope or hash mismatch')
    WHERE NOT EXISTS (
      SELECT 1
        FROM notes AS source
       WHERE source.id = NEW.source_note_id
         AND source.user_id = NEW.tenant_id
         AND NEW.tenant_id = NEW.owner_user_id
         AND lower(trim(
               COALESCE(source.domain, ''),
               char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
               || char(133) || char(160) || char(5760)
               || char(8192) || char(8193) || char(8194) || char(8195)
               || char(8196) || char(8197) || char(8198) || char(8199)
               || char(8200) || char(8201) || char(8202) || char(8232)
               || char(8233) || char(8239) || char(8287) || char(12288)
             )) = 'content_idea'
         AND trim(
               COALESCE(source.content, ''),
               char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
               || char(133) || char(160) || char(5760)
               || char(8192) || char(8193) || char(8194) || char(8195)
               || char(8196) || char(8197) || char(8198) || char(8199)
               || char(8200) || char(8201) || char(8202) || char(8232)
               || char(8233) || char(8239) || char(8287) || char(12288)
             ) <> ''
         AND nexus_sha256(source.content) = NEW.source_hash
    );

  SELECT RAISE(ABORT, 'content legacy idea note item scope mismatch')
    WHERE NOT EXISTS (
      SELECT 1
        FROM content_domain_objects AS item
       WHERE item.id = NEW.item_id
         AND item.tenant_id = NEW.tenant_id
         AND item.owner_user_id = NEW.owner_user_id
         AND item.object_type = 'content_item'
         AND item.visibility_scope = 'user_private'
         AND item.current_artifact_id = NEW.artifact_id
    );

  SELECT RAISE(ABORT, 'content legacy idea note artifact scope mismatch')
    WHERE NOT EXISTS (
      SELECT 1
        FROM content_artifacts AS artifact
       WHERE artifact.id = NEW.artifact_id
         AND artifact.item_id = NEW.item_id
         AND artifact.tenant_id = NEW.tenant_id
         AND artifact.owner_user_id = NEW.owner_user_id
         AND artifact.artifact_type = 'idea_note'
         AND artifact.current_revision_id = NEW.revision_id
         AND artifact.revision_count = 1
    );

  SELECT RAISE(ABORT, 'content legacy idea note revision scope or bytes mismatch')
    WHERE NOT EXISTS (
      SELECT 1
        FROM content_revisions AS revision
        JOIN notes AS source ON source.id = NEW.source_note_id
       WHERE revision.id = NEW.revision_id
         AND revision.artifact_id = NEW.artifact_id
         AND revision.tenant_id = NEW.tenant_id
         AND revision.owner_user_id = NEW.owner_user_id
         AND revision.revision_number = 1
         AND revision.content_format = 'plain_text'
         AND revision.content_text = source.content
         AND revision.content_hash = nexus_plain_text_revision_hash(source.content)
    );
END;

DROP TRIGGER IF EXISTS trg_content_legacy_idea_note_ingress_immutable_update;
CREATE TRIGGER trg_content_legacy_idea_note_ingress_immutable_update
BEFORE UPDATE ON content_legacy_idea_note_ingress_bindings
BEGIN
  SELECT RAISE(ABORT, 'content legacy idea note ingress binding is immutable');
END;

-- A direct delete cannot erase provenance while its canonical item survives.
-- Cascaded graph deletion remains possible because the parent is absent when
-- the foreign-key action reaches this trigger. Account/legal erasure is also
-- explicitly allowed by the existing short-lived subject authorization.
DROP TRIGGER IF EXISTS trg_content_legacy_idea_note_ingress_immutable_delete;
CREATE TRIGGER trg_content_legacy_idea_note_ingress_immutable_delete
BEFORE DELETE ON content_legacy_idea_note_ingress_bindings
WHEN EXISTS (
       SELECT 1 FROM content_domain_objects AS item WHERE item.id = OLD.item_id
     )
 AND NOT EXISTS (
       SELECT 1
         FROM training_revision_erasure_authorizations AS authorization
        WHERE authorization.subject_user_id = OLD.owner_user_id
          AND authorization.reason IN ('ACCOUNT_DELETION', 'LEGAL_ERASURE')
          AND datetime(authorization.expires_at) >= datetime('now')
     )
BEGIN
  SELECT RAISE(ABORT, 'content legacy idea note ingress binding is immutable');
END;

DROP TRIGGER IF EXISTS trg_content_legacy_idea_note_quarantine_immutable;
CREATE TRIGGER trg_content_legacy_idea_note_quarantine_immutable
BEFORE UPDATE ON content_legacy_idea_note_quarantine
BEGIN
  SELECT RAISE(ABORT, 'content legacy idea note quarantine is immutable');
END;

-- Allocate one independent item per note. Legacy notes have no title column,
-- so the first 120 normalized display characters become a useful title while
-- the immutable revision keeps the exact source bytes, including whitespace.
INSERT INTO content_domain_objects (
  tenant_id,
  owner_user_id,
  visibility_scope,
  scope_status,
  object_type,
  lifecycle_state,
  title,
  summary,
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
  note.user_id,
  note.user_id,
  'user_private',
  'active',
  'content_item',
  'active',
  substr(
    trim(
      replace(replace(replace(note.content, char(13), ' '), char(10), ' '), char(9), ' '),
      char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
      || char(133) || char(160) || char(5760)
      || char(8192) || char(8193) || char(8194) || char(8195)
      || char(8196) || char(8197) || char(8198) || char(8199)
      || char(8200) || char(8201) || char(8202) || char(8232)
      || char(8233) || char(8239) || char(8287) || char(12288)
    ),
    1,
    120
  ),
  NULL,
  json_array('legacy_note:' || note.id),
  json_object(
    'migration', 'content_legacy_idea_note_253',
    'legacyNoteId', note.id,
    'contentParity', 'artifact_pinned',
    'captureOrigin', 'legacy_content_idea_note_backfill'
  ),
  'content-ontology-v1',
  'idea',
  'not_required',
  0,
  '[]',
  'idea',
  'inbox',
  3,
  json_object('action', 'develop_idea'),
  0,
  'content-workspace-v1',
  note.user_id,
  note.user_id,
  json_object(
    'migration', 'content_legacy_idea_note_253',
    'legacyNoteId', note.id,
    'legacyRawDomain', note.domain,
    'legacyRawTags', note.tags,
    'sourceHash', nexus_sha256(note.content),
    'contentParity', 'artifact_pinned'
  ),
  COALESCE(note.created_at, datetime('now')),
  COALESCE(note.created_at, datetime('now'))
FROM notes AS note
WHERE note.user_id > 0
  AND lower(trim(
        COALESCE(note.domain, ''),
        char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
        || char(133) || char(160) || char(5760)
        || char(8192) || char(8193) || char(8194) || char(8195)
        || char(8196) || char(8197) || char(8198) || char(8199)
        || char(8200) || char(8201) || char(8202) || char(8232)
        || char(8233) || char(8239) || char(8287) || char(12288)
      )) = 'content_idea'
  AND trim(
        COALESCE(note.content, ''),
        char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
        || char(133) || char(160) || char(5760)
        || char(8192) || char(8193) || char(8194) || char(8195)
        || char(8196) || char(8197) || char(8198) || char(8199)
        || char(8200) || char(8201) || char(8202) || char(8232)
        || char(8233) || char(8239) || char(8287) || char(12288)
      ) <> ''
  AND NOT EXISTS (
    SELECT 1
      FROM content_domain_objects AS existing
     WHERE existing.tenant_id = note.user_id
       AND existing.owner_user_id = note.user_id
       AND json_extract(existing.audit_metadata_json, '$.migration') = 'content_legacy_idea_note_253'
       AND json_extract(existing.audit_metadata_json, '$.legacyNoteId') = note.id
  );

INSERT INTO content_artifacts (
  tenant_id,
  owner_user_id,
  visibility_scope,
  scope_status,
  item_id,
  artifact_type,
  title,
  metadata_json,
  schema_version,
  created_by,
  updated_by,
  created_at,
  updated_at
)
SELECT
  note.user_id,
  note.user_id,
  'user_private',
  'active',
  item.id,
  'idea_note',
  item.title,
  json_object(
    'migration', 'content_legacy_idea_note_253',
    'legacyNoteId', note.id,
    'legacyRawDomain', note.domain,
    'legacyRawTags', note.tags,
    'captureOrigin', 'legacy_content_idea_note_backfill',
    'sourceHash', nexus_sha256(note.content)
  ),
  'content-artifact-v1',
  note.user_id,
  note.user_id,
  COALESCE(note.created_at, datetime('now')),
  COALESCE(note.created_at, datetime('now'))
FROM notes AS note
JOIN content_domain_objects AS item
  ON item.tenant_id = note.user_id
 AND item.owner_user_id = note.user_id
 AND json_extract(item.audit_metadata_json, '$.migration') = 'content_legacy_idea_note_253'
 AND json_extract(item.audit_metadata_json, '$.legacyNoteId') = note.id
WHERE NOT EXISTS (
  SELECT 1
    FROM content_artifacts AS existing
   WHERE existing.tenant_id = note.user_id
     AND existing.owner_user_id = note.user_id
     AND json_extract(existing.metadata_json, '$.migration') = 'content_legacy_idea_note_253'
     AND json_extract(existing.metadata_json, '$.legacyNoteId') = note.id
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
  note.user_id,
  note.user_id,
  artifact.id,
  1,
  NULL,
  NULL,
  'plain_text',
  note.content,
  NULL,
  nexus_plain_text_revision_hash(note.content),
  'Imported lossless legacy Content idea note',
  'legacy_content_idea_note_backfill',
  'import',
  'migration-253',
  json_object(
    'migration', 'content_legacy_idea_note_253',
    'legacyNoteId', note.id,
    'legacyRawDomain', note.domain,
    'legacyRawTags', note.tags,
    'sourceHash', nexus_sha256(note.content)
  ),
  'content-revision-v1',
  note.user_id,
  COALESCE(note.created_at, datetime('now'))
FROM notes AS note
JOIN content_artifacts AS artifact
  ON artifact.tenant_id = note.user_id
 AND artifact.owner_user_id = note.user_id
 AND json_extract(artifact.metadata_json, '$.migration') = 'content_legacy_idea_note_253'
 AND json_extract(artifact.metadata_json, '$.legacyNoteId') = note.id
WHERE NOT EXISTS (
  SELECT 1 FROM content_revisions AS existing WHERE existing.artifact_id = artifact.id
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
       revision_count = 1
 WHERE json_extract(metadata_json, '$.migration') = 'content_legacy_idea_note_253'
   AND current_revision_id IS NULL;

UPDATE content_domain_objects
   SET current_artifact_id = (
         SELECT artifact.id
           FROM content_artifacts AS artifact
          WHERE artifact.item_id = content_domain_objects.id
            AND artifact.tenant_id = content_domain_objects.tenant_id
            AND artifact.owner_user_id = content_domain_objects.owner_user_id
            AND json_extract(artifact.metadata_json, '$.migration') = 'content_legacy_idea_note_253'
          LIMIT 1
       )
 WHERE json_extract(audit_metadata_json, '$.migration') = 'content_legacy_idea_note_253'
   AND current_artifact_id IS NULL;

INSERT INTO content_legacy_idea_note_ingress_bindings (
  tenant_id,
  owner_user_id,
  source_note_id,
  source_hash,
  item_id,
  artifact_id,
  revision_id
)
SELECT
  note.user_id,
  note.user_id,
  note.id,
  nexus_sha256(note.content),
  item.id,
  artifact.id,
  revision.id
FROM notes AS note
JOIN content_domain_objects AS item
  ON item.tenant_id = note.user_id
 AND item.owner_user_id = note.user_id
 AND json_extract(item.audit_metadata_json, '$.migration') = 'content_legacy_idea_note_253'
 AND json_extract(item.audit_metadata_json, '$.legacyNoteId') = note.id
JOIN content_artifacts AS artifact
  ON artifact.id = item.current_artifact_id
 AND artifact.item_id = item.id
 AND artifact.tenant_id = item.tenant_id
 AND artifact.owner_user_id = item.owner_user_id
JOIN content_revisions AS revision
  ON revision.id = artifact.current_revision_id
 AND revision.artifact_id = artifact.id
 AND revision.tenant_id = artifact.tenant_id
 AND revision.owner_user_id = artifact.owner_user_id
WHERE NOT EXISTS (
  SELECT 1
    FROM content_legacy_idea_note_ingress_bindings AS existing
   WHERE existing.tenant_id = note.user_id
     AND existing.owner_user_id = note.user_id
     AND existing.source_note_id = note.id
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
  'legacy_content_idea_note_migrated',
  'legacy_note',
  'inbox',
  'not_required',
  0,
  '["legacy_content_idea_note_import"]',
  binding.owner_user_id,
  json_object(
    'sourceNoteId', binding.source_note_id,
    'sourceHash', binding.source_hash,
    'artifactId', binding.artifact_id,
    'revisionId', binding.revision_id,
    'schemaVersion', binding.schema_version
  ),
  binding.created_at
FROM content_legacy_idea_note_ingress_bindings AS binding
WHERE NOT EXISTS (
  SELECT 1
    FROM content_workflow_events AS event
   WHERE event.tenant_id = binding.tenant_id
     AND event.owner_user_id = binding.owner_user_id
     AND event.object_type = 'content_item'
     AND event.object_id = CAST(binding.item_id AS TEXT)
     AND event.action = 'legacy_content_idea_note_migrated'
     AND json_extract(event.metadata_json, '$.sourceNoteId') = binding.source_note_id
);

-- Normalize legacy JSON-array or comma-delimited tags into the scoped tag
-- library. Raw tag bytes remain in item/artifact/revision provenance even when
-- an individual value is blank, duplicated, malformed, or longer than 80
-- characters and therefore unsuitable for a canonical tag.
DROP TABLE IF EXISTS temp_content_legacy_idea_note_tags;
CREATE TEMP TABLE temp_content_legacy_idea_note_tags AS
WITH RECURSIVE
eligible_notes AS (
  SELECT note.id, note.user_id, note.tags
    FROM notes AS note
    JOIN content_legacy_idea_note_ingress_bindings AS binding
      ON binding.source_note_id = note.id
     AND binding.tenant_id = note.user_id
     AND binding.owner_user_id = note.user_id
),
json_tags AS (
  SELECT note.id AS source_note_id,
         note.user_id,
         CAST(tag.value AS TEXT) AS raw_tag
    FROM eligible_notes AS note,
         json_each(
           CASE
             WHEN json_valid(note.tags)
               THEN CASE WHEN json_type(note.tags) = 'array' THEN note.tags ELSE '[]' END
             ELSE '[]'
           END
         ) AS tag
   WHERE tag.type IN ('text', 'integer', 'real')
),
csv_tags(source_note_id, user_id, remaining, raw_tag) AS (
  SELECT note.id,
         note.user_id,
         CASE
           WHEN json_valid(note.tags)
             THEN CASE
               WHEN json_type(note.tags) = 'array' THEN ''
               ELSE COALESCE(note.tags, '') || ','
             END
           ELSE COALESCE(note.tags, '') || ','
         END,
         NULL
    FROM eligible_notes AS note
  UNION ALL
  SELECT source_note_id,
         user_id,
         substr(remaining, instr(remaining, ',') + 1),
         substr(remaining, 1, instr(remaining, ',') - 1)
    FROM csv_tags
   WHERE remaining <> ''
),
raw_tags AS (
  SELECT source_note_id, user_id, raw_tag FROM json_tags
  UNION ALL
  SELECT source_note_id, user_id, raw_tag
    FROM csv_tags
   WHERE raw_tag IS NOT NULL
)
SELECT DISTINCT
  source_note_id,
  user_id,
  substr(trim(
    raw_tag,
    char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
    || char(133) || char(160) || char(5760)
    || char(8192) || char(8193) || char(8194) || char(8195)
    || char(8196) || char(8197) || char(8198) || char(8199)
    || char(8200) || char(8201) || char(8202) || char(8232)
    || char(8233) || char(8239) || char(8287) || char(12288)
  ), 1, 80) AS display_name,
  lower(substr(trim(
    raw_tag,
    char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
    || char(133) || char(160) || char(5760)
    || char(8192) || char(8193) || char(8194) || char(8195)
    || char(8196) || char(8197) || char(8198) || char(8199)
    || char(8200) || char(8201) || char(8202) || char(8232)
    || char(8233) || char(8239) || char(8287) || char(12288)
  ), 1, 80)) AS normalized_name
FROM raw_tags
WHERE trim(
        COALESCE(raw_tag, ''),
        char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
        || char(133) || char(160) || char(5760)
        || char(8192) || char(8193) || char(8194) || char(8195)
        || char(8196) || char(8197) || char(8198) || char(8199)
        || char(8200) || char(8201) || char(8202) || char(8232)
        || char(8233) || char(8239) || char(8287) || char(12288)
      ) <> '';

INSERT OR IGNORE INTO content_tags (
  tenant_id,
  owner_user_id,
  visibility_scope,
  scope_status,
  display_name,
  normalized_name,
  created_by,
  updated_by
)
SELECT DISTINCT
  tag.user_id,
  tag.user_id,
  'user_private',
  'active',
  tag.display_name,
  tag.normalized_name,
  tag.user_id,
  tag.user_id
FROM temp_content_legacy_idea_note_tags AS tag;

INSERT OR IGNORE INTO content_item_tags (
  tenant_id,
  owner_user_id,
  item_id,
  tag_id,
  created_by
)
SELECT
  parsed.user_id,
  parsed.user_id,
  binding.item_id,
  tag.id,
  parsed.user_id
FROM temp_content_legacy_idea_note_tags AS parsed
JOIN content_legacy_idea_note_ingress_bindings AS binding
  ON binding.source_note_id = parsed.source_note_id
 AND binding.tenant_id = parsed.user_id
 AND binding.owner_user_id = parsed.user_id
JOIN content_tags AS tag
  ON tag.tenant_id = parsed.user_id
 AND tag.owner_user_id = parsed.user_id
 AND tag.normalized_name = parsed.normalized_name;

DROP TABLE temp_content_legacy_idea_note_tags;

INSERT OR IGNORE INTO content_legacy_idea_note_quarantine (
  source_note_id,
  owner_user_id,
  source_hash,
  reason_code,
  metadata_json,
  created_at
)
SELECT
  note.id,
  CASE WHEN note.user_id > 0 THEN note.user_id ELSE 0 END,
  nexus_sha256(note.content),
  CASE
    WHEN note.user_id <= 0
     AND trim(
           COALESCE(note.content, ''),
           char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
           || char(133) || char(160) || char(5760)
           || char(8192) || char(8193) || char(8194) || char(8195)
           || char(8196) || char(8197) || char(8198) || char(8199)
           || char(8200) || char(8201) || char(8202) || char(8232)
           || char(8233) || char(8239) || char(8287) || char(12288)
         ) = ''
      THEN 'ownerless_and_blank_body'
    WHEN note.user_id <= 0 THEN 'ownerless_user'
    ELSE 'blank_body'
  END,
  json_object(
    'migration', 'content_legacy_idea_note_253',
    'legacyRawDomain', note.domain,
    'legacyRawTags', note.tags,
    'sourceRetained', 1
  ),
  COALESCE(note.created_at, datetime('now'))
FROM notes AS note
WHERE lower(trim(
        COALESCE(note.domain, ''),
        char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
        || char(133) || char(160) || char(5760)
        || char(8192) || char(8193) || char(8194) || char(8195)
        || char(8196) || char(8197) || char(8198) || char(8199)
        || char(8200) || char(8201) || char(8202) || char(8232)
        || char(8233) || char(8239) || char(8287) || char(12288)
      )) = 'content_idea'
  AND (
    note.user_id <= 0
    OR trim(
         COALESCE(note.content, ''),
         char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
         || char(133) || char(160) || char(5760)
         || char(8192) || char(8193) || char(8194) || char(8195)
         || char(8196) || char(8197) || char(8198) || char(8199)
         || char(8200) || char(8201) || char(8202) || char(8232)
         || char(8233) || char(8239) || char(8287) || char(12288)
       ) = ''
  );

-- Preserve the older saved_ideas root independently. The item title is a
-- bounded display projection; the exact title bytes and every historical
-- metadata field remain in the immutable revision/binding snapshot.
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
  source.resolved_tenant_id,
  source.resolved_owner_user_id,
  'user_private',
  'active',
  'content_item',
  CASE
    WHEN lower(trim(COALESCE(source.status, ''))) IN ('archived', 'cancelled', 'deleted')
      THEN 'archived'
    WHEN lower(trim(COALESCE(source.status, ''))) IN ('published', 'approved', 'scheduled')
      THEN 'review'
    ELSE 'active'
  END,
  substr(trim(
    replace(replace(replace(source.title, char(13), ' '), char(10), ' '), char(9), ' '),
    char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
    || char(133) || char(160) || char(5760)
    || char(8192) || char(8193) || char(8194) || char(8195)
    || char(8196) || char(8197) || char(8198) || char(8199)
    || char(8200) || char(8201) || char(8202) || char(8232)
    || char(8233) || char(8239) || char(8287) || char(12288)
  ), 1, 120),
  CASE
    WHEN trim(COALESCE(source.why_now, '')) <> '' THEN substr(source.why_now, 1, 20000)
    WHEN trim(COALESCE(source.niche, '')) <> '' THEN substr(source.niche, 1, 20000)
    ELSE NULL
  END,
  source.platform_id,
  source.format_id,
  json_array('legacy_saved_idea:' || source.id),
  json_object(
    'migration', 'content_legacy_saved_idea_253',
    'legacySavedIdeaId', source.id,
    'contentParity', 'artifact_pinned',
    'captureOrigin', 'legacy_saved_idea_backfill',
    'legacySnapshot', json(source.source_snapshot_json)
  ),
  'content-ontology-v1',
  CASE
    WHEN lower(trim(COALESCE(source.status, ''))) IN ('published', 'approved', 'scheduled')
      THEN 'review'
    WHEN lower(trim(COALESCE(source.status, ''))) IN ('archived', 'cancelled', 'deleted')
      THEN 'archived'
    ELSE 'idea'
  END,
  CASE
    WHEN lower(trim(COALESCE(source.status, ''))) IN ('published', 'approved', 'scheduled')
      THEN 'required'
    ELSE 'not_required'
  END,
  CASE
    WHEN lower(trim(COALESCE(source.status, ''))) IN ('published', 'approved', 'scheduled')
      THEN 1
    ELSE 0
  END,
  CASE
    WHEN lower(trim(COALESCE(source.status, ''))) IN ('published', 'approved', 'scheduled')
      THEN '["legacy_saved_idea_state_requires_verification"]'
    ELSE '[]'
  END,
  'idea',
  CASE
    WHEN lower(trim(COALESCE(source.status, ''))) IN ('archived', 'cancelled', 'deleted')
      THEN 'archived'
    WHEN lower(trim(COALESCE(source.status, ''))) IN ('published', 'approved', 'scheduled')
      THEN 'review'
    ELSE 'inbox'
  END,
  3,
  json_object('action', 'develop_idea'),
  0,
  'content-workspace-v1',
  source.resolved_owner_user_id,
  source.resolved_owner_user_id,
  json_object(
    'migration', 'content_legacy_saved_idea_253',
    'legacySavedIdeaId', source.id,
    'legacyStatusClaim', source.status,
    'sourceHash', source.source_hash,
    'contentParity', 'artifact_pinned',
    'legacySnapshot', json(source.source_snapshot_json)
  ),
  COALESCE(source.created_at, datetime('now')),
  COALESCE(source.created_at, datetime('now'))
FROM content_legacy_saved_idea_source_state AS source
WHERE source.is_eligible = 1
  AND NOT EXISTS (
    SELECT 1
      FROM content_domain_objects AS existing
     WHERE existing.tenant_id = source.resolved_tenant_id
       AND existing.owner_user_id = source.resolved_owner_user_id
       AND json_extract(existing.audit_metadata_json, '$.migration') = 'content_legacy_saved_idea_253'
       AND json_extract(existing.audit_metadata_json, '$.legacySavedIdeaId') = source.id
  );

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
  source.resolved_tenant_id,
  source.resolved_owner_user_id,
  'user_private',
  'active',
  item.id,
  'idea_note',
  item.title,
  source.platform_id,
  source.format_id,
  json_object(
    'migration', 'content_legacy_saved_idea_253',
    'legacySavedIdeaId', source.id,
    'legacyStatusClaim', source.status,
    'captureOrigin', 'legacy_saved_idea_backfill',
    'sourceHash', source.source_hash,
    'legacySnapshot', json(source.source_snapshot_json)
  ),
  'content-artifact-v1',
  source.resolved_owner_user_id,
  source.resolved_owner_user_id,
  COALESCE(source.created_at, datetime('now')),
  COALESCE(source.created_at, datetime('now'))
FROM content_legacy_saved_idea_source_state AS source
JOIN content_domain_objects AS item
  ON item.tenant_id = source.resolved_tenant_id
 AND item.owner_user_id = source.resolved_owner_user_id
 AND json_extract(item.audit_metadata_json, '$.migration') = 'content_legacy_saved_idea_253'
 AND json_extract(item.audit_metadata_json, '$.legacySavedIdeaId') = source.id
WHERE source.is_eligible = 1
  AND NOT EXISTS (
    SELECT 1
      FROM content_artifacts AS existing
     WHERE existing.tenant_id = source.resolved_tenant_id
       AND existing.owner_user_id = source.resolved_owner_user_id
       AND json_extract(existing.metadata_json, '$.migration') = 'content_legacy_saved_idea_253'
       AND json_extract(existing.metadata_json, '$.legacySavedIdeaId') = source.id
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
  source.resolved_tenant_id,
  source.resolved_owner_user_id,
  artifact.id,
  1,
  NULL,
  NULL,
  'plain_text',
  source.title,
  NULL,
  nexus_plain_text_revision_hash(source.title),
  'Imported lossless legacy saved idea',
  'legacy_saved_idea_backfill',
  'import',
  'migration-253',
  json_object(
    'migration', 'content_legacy_saved_idea_253',
    'legacySavedIdeaId', source.id,
    'sourceHash', source.source_hash,
    'legacySnapshot', json(source.source_snapshot_json)
  ),
  'content-revision-v1',
  source.resolved_owner_user_id,
  COALESCE(source.created_at, datetime('now'))
FROM content_legacy_saved_idea_source_state AS source
JOIN content_artifacts AS artifact
  ON artifact.tenant_id = source.resolved_tenant_id
 AND artifact.owner_user_id = source.resolved_owner_user_id
 AND json_extract(artifact.metadata_json, '$.migration') = 'content_legacy_saved_idea_253'
 AND json_extract(artifact.metadata_json, '$.legacySavedIdeaId') = source.id
WHERE source.is_eligible = 1
  AND NOT EXISTS (
    SELECT 1 FROM content_revisions AS existing WHERE existing.artifact_id = artifact.id
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
       revision_count = 1
 WHERE json_extract(metadata_json, '$.migration') = 'content_legacy_saved_idea_253'
   AND current_revision_id IS NULL;

UPDATE content_domain_objects
   SET current_artifact_id = (
         SELECT artifact.id
           FROM content_artifacts AS artifact
          WHERE artifact.item_id = content_domain_objects.id
            AND artifact.tenant_id = content_domain_objects.tenant_id
            AND artifact.owner_user_id = content_domain_objects.owner_user_id
            AND json_extract(artifact.metadata_json, '$.migration') = 'content_legacy_saved_idea_253'
          LIMIT 1
       )
 WHERE json_extract(audit_metadata_json, '$.migration') = 'content_legacy_saved_idea_253'
   AND current_artifact_id IS NULL;

INSERT INTO content_legacy_saved_idea_ingress_bindings (
  tenant_id,
  owner_user_id,
  source_saved_idea_id,
  source_hash,
  source_snapshot_json,
  item_id,
  artifact_id,
  revision_id
)
SELECT
  source.resolved_tenant_id,
  source.resolved_owner_user_id,
  source.id,
  source.source_hash,
  source.source_snapshot_json,
  item.id,
  artifact.id,
  revision.id
FROM content_legacy_saved_idea_source_state AS source
JOIN content_domain_objects AS item
  ON item.tenant_id = source.resolved_tenant_id
 AND item.owner_user_id = source.resolved_owner_user_id
 AND json_extract(item.audit_metadata_json, '$.migration') = 'content_legacy_saved_idea_253'
 AND json_extract(item.audit_metadata_json, '$.legacySavedIdeaId') = source.id
JOIN content_artifacts AS artifact
  ON artifact.id = item.current_artifact_id
 AND artifact.item_id = item.id
 AND artifact.tenant_id = item.tenant_id
 AND artifact.owner_user_id = item.owner_user_id
JOIN content_revisions AS revision
  ON revision.id = artifact.current_revision_id
 AND revision.artifact_id = artifact.id
 AND revision.tenant_id = artifact.tenant_id
 AND revision.owner_user_id = artifact.owner_user_id
WHERE source.is_eligible = 1
  AND NOT EXISTS (
    SELECT 1
      FROM content_legacy_saved_idea_ingress_bindings AS existing
     WHERE existing.tenant_id = source.resolved_tenant_id
       AND existing.owner_user_id = source.resolved_owner_user_id
       AND existing.source_saved_idea_id = source.id
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
  'legacy_saved_idea_migrated',
  source.status,
  item.production_state,
  item.approval_state,
  item.review_required,
  '["legacy_saved_idea_import"]',
  binding.owner_user_id,
  json_object(
    'sourceSavedIdeaId', binding.source_saved_idea_id,
    'sourceHash', binding.source_hash,
    'artifactId', binding.artifact_id,
    'revisionId', binding.revision_id,
    'legacyStatusClaim', source.status,
    'schemaVersion', binding.schema_version
  ),
  binding.created_at
FROM content_legacy_saved_idea_ingress_bindings AS binding
JOIN content_legacy_saved_idea_source_state AS source
  ON source.id = binding.source_saved_idea_id
 AND source.resolved_tenant_id = binding.tenant_id
 AND source.resolved_owner_user_id = binding.owner_user_id
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
     AND event.action = 'legacy_saved_idea_migrated'
     AND json_extract(event.metadata_json, '$.sourceSavedIdeaId') = binding.source_saved_idea_id
);

INSERT OR IGNORE INTO content_legacy_saved_idea_quarantine (
  source_saved_idea_id,
  observed_user_id,
  observed_tenant_id,
  observed_owner_user_id,
  source_hash,
  reason_code,
  metadata_json,
  created_at
)
SELECT
  source.id,
  CASE WHEN source.user_id > 0 THEN source.user_id ELSE 0 END,
  CASE WHEN COALESCE(source.tenant_id, 0) > 0 THEN source.tenant_id ELSE 0 END,
  CASE WHEN COALESCE(source.owner_user_id, 0) > 0 THEN source.owner_user_id ELSE 0 END,
  source.source_hash,
  source.ineligibility_reason,
  json_object(
    'migration', 'content_legacy_saved_idea_253',
    'sourceRetained', 1,
    'resolvedTenantId', source.resolved_tenant_id,
    'resolvedOwnerUserId', source.resolved_owner_user_id,
    'resolvedVisibilityScope', source.resolved_visibility_scope,
    'resolvedScopeStatus', source.resolved_scope_status,
    'titleBlank', CASE
      WHEN trim(
             COALESCE(source.title, ''),
             char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
             || char(133) || char(160) || char(5760)
             || char(8192) || char(8193) || char(8194) || char(8195)
             || char(8196) || char(8197) || char(8198) || char(8199)
             || char(8200) || char(8201) || char(8202) || char(8232)
             || char(8233) || char(8239) || char(8287) || char(12288)
           ) = '' THEN 1 ELSE 0 END
  ),
  COALESCE(source.created_at, datetime('now'))
FROM content_legacy_saved_idea_source_state AS source
WHERE source.is_eligible = 0;

DROP TRIGGER IF EXISTS trg_saved_ideas_legacy_user_insert_blocked;
CREATE TRIGGER trg_saved_ideas_legacy_user_insert_blocked
BEFORE INSERT ON saved_ideas
BEGIN
  SELECT RAISE(ABORT, 'saved_ideas is read-only after migration 253; use content workspace');
END;

DROP TRIGGER IF EXISTS trg_saved_ideas_legacy_user_update_blocked;
CREATE TRIGGER trg_saved_ideas_legacy_user_update_blocked
BEFORE UPDATE ON saved_ideas
BEGIN
  SELECT RAISE(ABORT, 'saved_ideas is read-only after migration 253; use content workspace');
END;

DROP TRIGGER IF EXISTS trg_saved_ideas_bound_source_delete_blocked;
CREATE TRIGGER trg_saved_ideas_bound_source_delete_blocked
BEFORE DELETE ON saved_ideas
WHEN EXISTS (
       SELECT 1
         FROM content_legacy_saved_idea_ingress_bindings AS binding
        WHERE binding.source_saved_idea_id = OLD.id
     )
 AND NOT EXISTS (
       SELECT 1
         FROM training_revision_erasure_authorizations AS authorization
         JOIN content_legacy_saved_idea_ingress_bindings AS binding
           ON binding.source_saved_idea_id = OLD.id
        WHERE authorization.subject_user_id = binding.owner_user_id
          AND authorization.reason IN ('ACCOUNT_DELETION', 'LEGAL_ERASURE')
          AND datetime(authorization.expires_at) >= datetime('now')
     )
BEGIN
  SELECT RAISE(ABORT, 'bound saved_ideas source is immutable outside account or legal erasure');
END;

-- Freeze every spelling/whitespace variant of the retired notes ingress.
-- DELETE stays available so the existing subject-scoped account-erasure
-- transaction can remove both source and canonical rows without a downgrade.
DROP TRIGGER IF EXISTS trg_notes_content_idea_insert_blocked;
CREATE TRIGGER trg_notes_content_idea_insert_blocked
BEFORE INSERT ON notes
WHEN lower(trim(
       COALESCE(NEW.domain, ''),
       char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
       || char(133) || char(160) || char(5760)
       || char(8192) || char(8193) || char(8194) || char(8195)
       || char(8196) || char(8197) || char(8198) || char(8199)
       || char(8200) || char(8201) || char(8202) || char(8232)
       || char(8233) || char(8239) || char(8287) || char(12288)
     )) = 'content_idea'
BEGIN
  SELECT RAISE(ABORT, 'notes content_idea ingress is read-only after migration 253; use content workspace');
END;

DROP TRIGGER IF EXISTS trg_notes_content_idea_update_blocked;
CREATE TRIGGER trg_notes_content_idea_update_blocked
BEFORE UPDATE ON notes
WHEN lower(trim(
       COALESCE(OLD.domain, ''),
       char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
       || char(133) || char(160) || char(5760)
       || char(8192) || char(8193) || char(8194) || char(8195)
       || char(8196) || char(8197) || char(8198) || char(8199)
       || char(8200) || char(8201) || char(8202) || char(8232)
       || char(8233) || char(8239) || char(8287) || char(12288)
     )) = 'content_idea'
  OR lower(trim(
       COALESCE(NEW.domain, ''),
       char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
       || char(133) || char(160) || char(5760)
       || char(8192) || char(8193) || char(8194) || char(8195)
       || char(8196) || char(8197) || char(8198) || char(8199)
       || char(8200) || char(8201) || char(8202) || char(8232)
       || char(8233) || char(8239) || char(8287) || char(12288)
     )) = 'content_idea'
BEGIN
  SELECT RAISE(ABORT, 'notes content_idea ingress is read-only after migration 253; use content workspace');
END;

DROP TRIGGER IF EXISTS trg_notes_bound_content_idea_delete_blocked;
CREATE TRIGGER trg_notes_bound_content_idea_delete_blocked
BEFORE DELETE ON notes
WHEN EXISTS (
       SELECT 1
         FROM content_legacy_idea_note_ingress_bindings AS binding
        WHERE binding.source_note_id = OLD.id
     )
 AND NOT EXISTS (
       SELECT 1
         FROM training_revision_erasure_authorizations AS authorization
         JOIN content_legacy_idea_note_ingress_bindings AS binding
           ON binding.source_note_id = OLD.id
        WHERE authorization.subject_user_id = binding.owner_user_id
          AND authorization.reason IN ('ACCOUNT_DELETION', 'LEGAL_ERASURE')
          AND datetime(authorization.expires_at) >= datetime('now')
     )
BEGIN
  SELECT RAISE(ABORT, 'bound notes content_idea source is immutable outside account or legal erasure');
END;

DROP VIEW IF EXISTS content_legacy_idea_note_workspace_readiness;
CREATE VIEW content_legacy_idea_note_workspace_readiness AS
WITH
eligible AS (
  SELECT note.id,
         note.user_id,
         note.content
    FROM notes AS note
   WHERE note.user_id > 0
     AND lower(trim(
           COALESCE(note.domain, ''),
           char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
           || char(133) || char(160) || char(5760)
           || char(8192) || char(8193) || char(8194) || char(8195)
           || char(8196) || char(8197) || char(8198) || char(8199)
           || char(8200) || char(8201) || char(8202) || char(8232)
           || char(8233) || char(8239) || char(8287) || char(12288)
         )) = 'content_idea'
     AND trim(
           COALESCE(note.content, ''),
           char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
           || char(133) || char(160) || char(5760)
           || char(8192) || char(8193) || char(8194) || char(8195)
           || char(8196) || char(8197) || char(8198) || char(8199)
           || char(8200) || char(8201) || char(8202) || char(8232)
           || char(8233) || char(8239) || char(8287) || char(12288)
         ) <> ''
),
eligible_chain AS (
  SELECT eligible.id AS source_note_id,
         eligible.user_id,
         eligible.content,
         binding.id AS binding_id,
         binding.source_hash,
         binding.item_id,
         binding.artifact_id,
         binding.revision_id,
         binding.content_parity_status,
         item.id AS scoped_item_id,
         item.current_artifact_id,
         artifact.id AS scoped_artifact_id,
         artifact.artifact_type,
         artifact.current_revision_id,
         artifact.revision_count,
         revision.id AS scoped_revision_id,
         revision.revision_number,
         revision.content_format,
         revision.content_text,
         revision.content_hash
    FROM eligible
    LEFT JOIN content_legacy_idea_note_ingress_bindings AS binding
      ON binding.source_note_id = eligible.id
     AND binding.tenant_id = eligible.user_id
     AND binding.owner_user_id = eligible.user_id
    LEFT JOIN content_domain_objects AS item
      ON item.id = binding.item_id
     AND item.tenant_id = binding.tenant_id
     AND item.owner_user_id = binding.owner_user_id
     AND item.object_type = 'content_item'
     AND item.visibility_scope = 'user_private'
    LEFT JOIN content_artifacts AS artifact
      ON artifact.id = binding.artifact_id
     AND artifact.item_id = binding.item_id
     AND artifact.tenant_id = binding.tenant_id
     AND artifact.owner_user_id = binding.owner_user_id
    LEFT JOIN content_revisions AS revision
      ON revision.id = binding.revision_id
     AND revision.artifact_id = binding.artifact_id
     AND revision.tenant_id = binding.tenant_id
     AND revision.owner_user_id = binding.owner_user_id
),
ineligible AS (
  SELECT note.id,
         CASE WHEN note.user_id > 0 THEN note.user_id ELSE 0 END AS owner_user_id,
         note.user_id,
         note.content,
         CASE
           WHEN note.user_id <= 0
            AND trim(
                  COALESCE(note.content, ''),
                  char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
                  || char(133) || char(160) || char(5760)
                  || char(8192) || char(8193) || char(8194) || char(8195)
                  || char(8196) || char(8197) || char(8198) || char(8199)
                  || char(8200) || char(8201) || char(8202) || char(8232)
                  || char(8233) || char(8239) || char(8287) || char(12288)
                ) = ''
             THEN 'ownerless_and_blank_body'
           WHEN note.user_id <= 0 THEN 'ownerless_user'
           ELSE 'blank_body'
         END AS reason_code
    FROM notes AS note
   WHERE lower(trim(
           COALESCE(note.domain, ''),
           char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
           || char(133) || char(160) || char(5760)
           || char(8192) || char(8193) || char(8194) || char(8195)
           || char(8196) || char(8197) || char(8198) || char(8199)
           || char(8200) || char(8201) || char(8202) || char(8232)
           || char(8233) || char(8239) || char(8287) || char(12288)
         )) = 'content_idea'
     AND (
       note.user_id <= 0
       OR trim(
            COALESCE(note.content, ''),
            char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
            || char(133) || char(160) || char(5760)
            || char(8192) || char(8193) || char(8194) || char(8195)
            || char(8196) || char(8197) || char(8198) || char(8199)
            || char(8200) || char(8201) || char(8202) || char(8232)
            || char(8233) || char(8239) || char(8287) || char(12288)
          ) = ''
     )
),
counts AS (
  SELECT
    (SELECT COUNT(*) FROM eligible) AS nonblank_eligible_source_count,
    (SELECT COUNT(*) FROM eligible_chain WHERE binding_id IS NOT NULL) AS bound_source_count,
    (SELECT COUNT(*) FROM eligible_chain WHERE binding_id IS NULL) AS unbound_eligible_source_count,
    (
      SELECT COUNT(*)
        FROM eligible_chain
       WHERE binding_id IS NOT NULL
         AND (
           source_hash <> nexus_sha256(content)
           OR content_parity_status <> 'artifact_pinned'
           OR scoped_item_id IS NULL
           OR scoped_artifact_id IS NULL
           OR scoped_revision_id IS NULL
           OR artifact_type <> 'idea_note'
           OR revision_number <> 1
           OR content_format <> 'plain_text'
           OR content_text <> content
           OR content_hash <> nexus_plain_text_revision_hash(content)
         )
    ) AS exact_byte_hash_mismatch_count,
    (
      SELECT COUNT(*)
        FROM content_legacy_idea_note_ingress_bindings AS binding
       WHERE NOT EXISTS (
         SELECT 1
           FROM notes AS source
          WHERE source.id = binding.source_note_id
            AND source.user_id = binding.tenant_id
            AND binding.tenant_id = binding.owner_user_id
            AND lower(trim(
                  COALESCE(source.domain, ''),
                  char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
                  || char(133) || char(160) || char(5760)
                  || char(8192) || char(8193) || char(8194) || char(8195)
                  || char(8196) || char(8197) || char(8198) || char(8199)
                  || char(8200) || char(8201) || char(8202) || char(8232)
                  || char(8233) || char(8239) || char(8287) || char(12288)
                )) = 'content_idea'
            AND trim(
                  COALESCE(source.content, ''),
                  char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
                  || char(133) || char(160) || char(5760)
                  || char(8192) || char(8193) || char(8194) || char(8195)
                  || char(8196) || char(8197) || char(8198) || char(8199)
                  || char(8200) || char(8201) || char(8202) || char(8232)
                  || char(8233) || char(8239) || char(8287) || char(12288)
                ) <> ''
            AND nexus_sha256(source.content) = binding.source_hash
       )
    ) AS orphan_or_changed_binding_count,
    (SELECT COUNT(*) FROM ineligible) AS quarantinable_source_count,
    (
      SELECT COUNT(*)
        FROM ineligible
        JOIN content_legacy_idea_note_quarantine AS quarantine
          ON quarantine.source_note_id = ineligible.id
         AND quarantine.owner_user_id = ineligible.owner_user_id
         AND quarantine.source_hash = nexus_sha256(ineligible.content)
         AND quarantine.reason_code = ineligible.reason_code
    ) AS quarantined_source_count,
    (
      SELECT COUNT(*)
        FROM ineligible
       WHERE ineligible.user_id <= 0
         AND EXISTS (
           SELECT 1
             FROM content_legacy_idea_note_quarantine AS quarantine
            WHERE quarantine.source_note_id = ineligible.id
              AND quarantine.source_hash = nexus_sha256(ineligible.content)
         )
    ) AS user_id_zero_quarantine_count,
    (
      SELECT COUNT(*)
        FROM ineligible
       WHERE trim(
               COALESCE(ineligible.content, ''),
               char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
               || char(133) || char(160) || char(5760)
               || char(8192) || char(8193) || char(8194) || char(8195)
               || char(8196) || char(8197) || char(8198) || char(8199)
               || char(8200) || char(8201) || char(8202) || char(8232)
               || char(8233) || char(8239) || char(8287) || char(12288)
             ) = ''
         AND EXISTS (
           SELECT 1
             FROM content_legacy_idea_note_quarantine AS quarantine
            WHERE quarantine.source_note_id = ineligible.id
              AND quarantine.source_hash = nexus_sha256(ineligible.content)
         )
    ) AS blank_body_quarantine_count,
    (
      SELECT COUNT(*)
        FROM ineligible
       WHERE NOT EXISTS (
         SELECT 1
           FROM content_legacy_idea_note_quarantine AS quarantine
          WHERE quarantine.source_note_id = ineligible.id
            AND quarantine.owner_user_id = ineligible.owner_user_id
            AND quarantine.source_hash = nexus_sha256(ineligible.content)
            AND quarantine.reason_code = ineligible.reason_code
       )
    ) AS unquarantined_ineligible_source_count,
    (
      SELECT COUNT(*)
        FROM sqlite_master
       WHERE type = 'trigger'
         AND name IN (
           'trg_notes_content_idea_insert_blocked',
           'trg_notes_content_idea_update_blocked'
         )
    ) AS writer_guard_count,
    (
      SELECT COUNT(*)
        FROM sqlite_master
       WHERE type = 'trigger'
         AND name = 'trg_notes_bound_content_idea_delete_blocked'
    ) AS source_delete_guard_count,
    (
      SELECT COUNT(*)
        FROM sqlite_master
       WHERE type = 'trigger'
         AND name IN (
           'trg_content_legacy_idea_note_ingress_scope_insert',
           'trg_content_legacy_idea_note_ingress_immutable_update',
           'trg_content_legacy_idea_note_ingress_immutable_delete'
         )
    ) AS binding_guard_count,
    (
      SELECT COUNT(*)
        FROM sqlite_master
       WHERE type = 'trigger'
         AND name = 'trg_content_legacy_idea_note_quarantine_immutable'
    ) AS quarantine_guard_count
)
SELECT counts.*,
       CASE
         WHEN bound_source_count = nonblank_eligible_source_count
          AND unbound_eligible_source_count = 0
          AND exact_byte_hash_mismatch_count = 0
          AND orphan_or_changed_binding_count = 0
          AND quarantined_source_count = quarantinable_source_count
          AND unquarantined_ineligible_source_count = 0
          AND writer_guard_count = 2
          AND source_delete_guard_count = 1
          AND binding_guard_count = 3
          AND quarantine_guard_count = 1
           THEN 'ready'
         ELSE 'blocked'
       END AS readiness_status
  FROM counts;

DROP VIEW IF EXISTS content_legacy_saved_idea_workspace_readiness;
CREATE VIEW content_legacy_saved_idea_workspace_readiness AS
WITH
eligible_chain AS (
  SELECT source.id AS source_saved_idea_id,
         source.resolved_tenant_id,
         source.resolved_owner_user_id,
         source.title,
         source.source_hash AS current_source_hash,
         source.source_snapshot_json AS current_source_snapshot_json,
         binding.id AS binding_id,
         binding.source_hash AS bound_source_hash,
         binding.source_snapshot_json AS bound_source_snapshot_json,
         binding.item_id,
         binding.artifact_id,
         binding.revision_id,
         binding.content_parity_status,
         item.id AS scoped_item_id,
         artifact.id AS scoped_artifact_id,
         artifact.artifact_type,
         revision.id AS scoped_revision_id,
         revision.revision_number,
         revision.content_format,
         revision.content_text,
         revision.content_hash
    FROM content_legacy_saved_idea_source_state AS source
    LEFT JOIN content_legacy_saved_idea_ingress_bindings AS binding
      ON binding.source_saved_idea_id = source.id
     AND binding.tenant_id = source.resolved_tenant_id
     AND binding.owner_user_id = source.resolved_owner_user_id
    LEFT JOIN content_domain_objects AS item
      ON item.id = binding.item_id
     AND item.tenant_id = binding.tenant_id
     AND item.owner_user_id = binding.owner_user_id
     AND item.object_type = 'content_item'
     AND item.visibility_scope = 'user_private'
    LEFT JOIN content_artifacts AS artifact
      ON artifact.id = binding.artifact_id
     AND artifact.item_id = binding.item_id
     AND artifact.tenant_id = binding.tenant_id
     AND artifact.owner_user_id = binding.owner_user_id
    LEFT JOIN content_revisions AS revision
      ON revision.id = binding.revision_id
     AND revision.artifact_id = binding.artifact_id
     AND revision.tenant_id = binding.tenant_id
     AND revision.owner_user_id = binding.owner_user_id
   WHERE source.is_eligible = 1
),
ineligible AS (
  SELECT *
    FROM content_legacy_saved_idea_source_state
   WHERE is_eligible = 0
),
counts AS (
  SELECT
    (SELECT COUNT(*) FROM eligible_chain) AS eligible_source_count,
    (SELECT COUNT(*) FROM eligible_chain WHERE binding_id IS NOT NULL) AS bound_source_count,
    (SELECT COUNT(*) FROM eligible_chain WHERE binding_id IS NULL) AS unbound_eligible_source_count,
    (
      SELECT COUNT(*)
        FROM eligible_chain
       WHERE binding_id IS NOT NULL
         AND (
           bound_source_hash <> current_source_hash
           OR bound_source_snapshot_json <> current_source_snapshot_json
           OR content_parity_status <> 'artifact_pinned'
           OR scoped_item_id IS NULL
           OR scoped_artifact_id IS NULL
           OR scoped_revision_id IS NULL
           OR artifact_type <> 'idea_note'
           OR revision_number <> 1
           OR content_format <> 'plain_text'
           OR content_text <> title
           OR content_hash <> nexus_plain_text_revision_hash(title)
         )
    ) AS exact_metadata_hash_mismatch_count,
    (
      SELECT COUNT(*)
        FROM content_legacy_saved_idea_ingress_bindings AS binding
       WHERE NOT EXISTS (
         SELECT 1
           FROM content_legacy_saved_idea_source_state AS source
          WHERE source.id = binding.source_saved_idea_id
            AND source.is_eligible = 1
            AND source.resolved_tenant_id = binding.tenant_id
            AND source.resolved_owner_user_id = binding.owner_user_id
            AND source.source_hash = binding.source_hash
            AND source.source_snapshot_json = binding.source_snapshot_json
       )
    ) AS orphan_or_changed_binding_count,
    (SELECT COUNT(*) FROM ineligible) AS quarantinable_source_count,
    (
      SELECT COUNT(*)
        FROM ineligible AS source
        JOIN content_legacy_saved_idea_quarantine AS quarantine
          ON quarantine.source_saved_idea_id = source.id
         AND quarantine.source_hash = source.source_hash
         AND quarantine.reason_code = source.ineligibility_reason
    ) AS quarantined_source_count,
    (
      SELECT COUNT(*)
        FROM ineligible AS source
       WHERE NOT EXISTS (
         SELECT 1
           FROM content_legacy_saved_idea_quarantine AS quarantine
          WHERE quarantine.source_saved_idea_id = source.id
            AND quarantine.source_hash = source.source_hash
            AND quarantine.reason_code = source.ineligibility_reason
       )
    ) AS unquarantined_ineligible_source_count,
    (
      SELECT COUNT(*)
        FROM sqlite_master
       WHERE type = 'trigger'
         AND name IN (
           'trg_saved_ideas_legacy_user_insert_blocked',
           'trg_saved_ideas_legacy_user_update_blocked'
         )
    ) AS writer_guard_count,
    (
      SELECT COUNT(*)
        FROM sqlite_master
       WHERE type = 'trigger'
         AND name = 'trg_saved_ideas_bound_source_delete_blocked'
    ) AS source_delete_guard_count,
    (
      SELECT COUNT(*)
        FROM sqlite_master
       WHERE type = 'trigger'
         AND name IN (
           'trg_content_legacy_saved_idea_ingress_scope_insert',
           'trg_content_legacy_saved_idea_ingress_immutable_update',
           'trg_content_legacy_saved_idea_ingress_immutable_delete'
         )
    ) AS binding_guard_count,
    (
      SELECT COUNT(*)
        FROM sqlite_master
       WHERE type = 'trigger'
         AND name = 'trg_content_legacy_saved_idea_quarantine_immutable'
    ) AS quarantine_guard_count
)
SELECT counts.*,
       CASE
         WHEN bound_source_count = eligible_source_count
          AND unbound_eligible_source_count = 0
          AND exact_metadata_hash_mismatch_count = 0
          AND orphan_or_changed_binding_count = 0
          AND quarantined_source_count = quarantinable_source_count
          AND unquarantined_ineligible_source_count = 0
          AND writer_guard_count = 2
          AND source_delete_guard_count = 1
          AND binding_guard_count = 3
          AND quarantine_guard_count = 1
           THEN 'ready'
         ELSE 'blocked'
       END AS readiness_status
  FROM counts;

-- Refuse to complete the cutover unless every eligible source is pinned
-- exactly, every intentionally ineligible source is classified, and all old
-- writer guards exist for both retired roots. The transaction rolls back as a
-- unit on any mismatch.
CREATE TEMP TABLE content_legacy_idea_note_253_readiness_guard (blocked INTEGER);
CREATE TEMP TRIGGER content_legacy_idea_note_253_readiness_guard_trigger
BEFORE INSERT ON content_legacy_idea_note_253_readiness_guard
WHEN EXISTS (
  SELECT 1
    FROM content_legacy_idea_note_workspace_readiness
   WHERE readiness_status <> 'ready'
)
 OR EXISTS (
  SELECT 1
    FROM content_legacy_saved_idea_workspace_readiness
   WHERE readiness_status <> 'ready'
 )
BEGIN
  SELECT RAISE(ABORT, 'content_legacy_idea_note_253_readiness_failed');
END;
INSERT INTO content_legacy_idea_note_253_readiness_guard(blocked) VALUES (1);
DROP TRIGGER content_legacy_idea_note_253_readiness_guard_trigger;
DROP TABLE content_legacy_idea_note_253_readiness_guard;
