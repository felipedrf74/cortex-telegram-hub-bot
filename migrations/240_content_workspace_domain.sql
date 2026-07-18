-- Migration 240: Canonical Content workspace domain.
--
-- Reuses content_domain_objects as the item/project root and adds typed,
-- tenant-scoped artifacts, immutable revisions, idempotency receipts, and
-- item relationships. Runtime services must not create or alter this schema.

ALTER TABLE content_domain_objects
  ADD COLUMN artifact_phase TEXT NOT NULL DEFAULT 'idea'
  CHECK (artifact_phase IN ('idea', 'brief', 'outline', 'draft', 'final'));

ALTER TABLE content_domain_objects
  ADD COLUMN production_state TEXT NOT NULL DEFAULT 'inbox'
  CHECK (production_state IN ('inbox', 'active', 'review', 'approved', 'scheduled', 'published', 'archived', 'rejected'));

ALTER TABLE content_domain_objects
  ADD COLUMN workspace_priority INTEGER NOT NULL DEFAULT 3
  CHECK (workspace_priority BETWEEN 1 AND 5);

ALTER TABLE content_domain_objects ADD COLUMN deadline_at TEXT;
ALTER TABLE content_domain_objects ADD COLUMN next_action_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE content_domain_objects ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1));
ALTER TABLE content_domain_objects ADD COLUMN current_artifact_id INTEGER;
ALTER TABLE content_domain_objects ADD COLUMN deleted_at TEXT;
ALTER TABLE content_domain_objects ADD COLUMN workspace_schema_version TEXT NOT NULL DEFAULT 'content-workspace-v1';

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_domain_objects_scoped_identity
  ON content_domain_objects(id, tenant_id, owner_user_id);

CREATE INDEX IF NOT EXISTS idx_content_workspace_items_library
  ON content_domain_objects(
    tenant_id,
    owner_user_id,
    scope_status,
    object_type,
    production_state,
    artifact_phase,
    updated_at
  );

CREATE INDEX IF NOT EXISTS idx_content_workspace_items_deadline
  ON content_domain_objects(tenant_id, owner_user_id, scope_status, deadline_at)
  WHERE deadline_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS content_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  owner_user_id INTEGER NOT NULL,
  visibility_scope TEXT NOT NULL DEFAULT 'user_private'
    CHECK (visibility_scope = 'user_private'),
  scope_status TEXT NOT NULL DEFAULT 'active'
    CHECK (scope_status IN ('active', 'archived', 'deleted')),
  item_id INTEGER NOT NULL,
  artifact_type TEXT NOT NULL
    CHECK (artifact_type IN (
      'idea_note', 'brief', 'outline', 'script', 'caption', 'shot_list',
      'platform_variant', 'research_notes', 'other'
    )),
  title TEXT,
  platform_id TEXT,
  format_id TEXT,
  current_revision_id INTEGER,
  revision_count INTEGER NOT NULL DEFAULT 0 CHECK (revision_count >= 0),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  schema_version TEXT NOT NULL DEFAULT 'content-artifact-v1',
  created_by INTEGER NOT NULL,
  updated_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (item_id, tenant_id, owner_user_id)
    REFERENCES content_domain_objects(id, tenant_id, owner_user_id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_artifacts_scoped_identity
  ON content_artifacts(id, tenant_id, owner_user_id);

CREATE INDEX IF NOT EXISTS idx_content_artifacts_item
  ON content_artifacts(tenant_id, owner_user_id, item_id, scope_status, created_at);

CREATE TABLE IF NOT EXISTS content_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  owner_user_id INTEGER NOT NULL,
  artifact_id INTEGER NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
  parent_revision_id INTEGER,
  restored_from_revision_id INTEGER,
  content_format TEXT NOT NULL
    CHECK (content_format IN ('plain_text', 'markdown', 'structured_json')),
  content_text TEXT,
  structured_content_json TEXT,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  change_summary TEXT,
  change_reason TEXT,
  actor_type TEXT NOT NULL DEFAULT 'user'
    CHECK (actor_type IN ('user', 'agent', 'system', 'import')),
  actor_id TEXT,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  schema_version TEXT NOT NULL DEFAULT 'content-revision-v1',
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (content_format IN ('plain_text', 'markdown') AND content_text IS NOT NULL AND structured_content_json IS NULL)
    OR
    (content_format = 'structured_json' AND content_text IS NULL AND structured_content_json IS NOT NULL)
  ),
  UNIQUE(artifact_id, revision_number),
  FOREIGN KEY (artifact_id, tenant_id, owner_user_id)
    REFERENCES content_artifacts(id, tenant_id, owner_user_id)
    ON DELETE CASCADE,
  FOREIGN KEY (parent_revision_id) REFERENCES content_revisions(id) ON DELETE SET NULL,
  FOREIGN KEY (restored_from_revision_id) REFERENCES content_revisions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_content_revisions_artifact
  ON content_revisions(tenant_id, owner_user_id, artifact_id, revision_number DESC);

CREATE TRIGGER IF NOT EXISTS trg_content_revisions_immutable_content_update
BEFORE UPDATE OF
  id,
  tenant_id,
  owner_user_id,
  artifact_id,
  revision_number,
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
ON content_revisions
BEGIN
  SELECT RAISE(ABORT, 'content revisions are immutable');
END;

-- Foreign-key erasure may clear a lineage pointer while deleting the full
-- account graph. Every other lineage rewrite remains blocked.
CREATE TRIGGER IF NOT EXISTS trg_content_revisions_immutable_lineage_update
BEFORE UPDATE OF parent_revision_id, restored_from_revision_id ON content_revisions
WHEN (
  NEW.parent_revision_id IS NOT OLD.parent_revision_id
  AND NOT (OLD.parent_revision_id IS NOT NULL AND NEW.parent_revision_id IS NULL)
) OR (
  NEW.restored_from_revision_id IS NOT OLD.restored_from_revision_id
  AND NOT (OLD.restored_from_revision_id IS NOT NULL AND NEW.restored_from_revision_id IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'content revision lineage is immutable');
END;

CREATE TABLE IF NOT EXISTS content_mutation_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  owner_user_id INTEGER NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  result_metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, owner_user_id, operation, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_content_mutation_receipts_resource
  ON content_mutation_receipts(tenant_id, owner_user_id, resource_type, resource_id);

CREATE TABLE IF NOT EXISTS content_item_relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  owner_user_id INTEGER NOT NULL,
  from_item_id INTEGER NOT NULL,
  to_item_id INTEGER NOT NULL,
  relationship_type TEXT NOT NULL
    CHECK (relationship_type IN ('contains', 'derived_from', 'variant_of', 'remix_of', 'related_to')),
  position INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (from_item_id <> to_item_id),
  UNIQUE(tenant_id, owner_user_id, from_item_id, to_item_id, relationship_type),
  FOREIGN KEY (from_item_id, tenant_id, owner_user_id)
    REFERENCES content_domain_objects(id, tenant_id, owner_user_id)
    ON DELETE CASCADE,
  FOREIGN KEY (to_item_id, tenant_id, owner_user_id)
    REFERENCES content_domain_objects(id, tenant_id, owner_user_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_content_item_relationships_from
  ON content_item_relationships(tenant_id, owner_user_id, from_item_id, relationship_type, position);

CREATE INDEX IF NOT EXISTS idx_content_item_relationships_to
  ON content_item_relationships(tenant_id, owner_user_id, to_item_id, relationship_type);
