-- Migration 250: bind measured Content outcomes to immutable workspace revisions.
--
-- content_performance remains the measured-outcome record so existing learning
-- and reporting reads retain their history. The link ledger below is the only
-- live association path: every canonical outcome is scoped to one Content item,
-- artifact, and immutable revision. `pipeline_id` is retained only as a frozen
-- compatibility alias for rows written before this migration.
--
-- Backfill is deliberately conservative. A legacy pipeline alias is linked only
-- when migration 246 already recorded an artifact_pinned legacy_pipeline ingress
-- binding. A metadata-only binding does not prove which revision produced the
-- measured result and is therefore left unlinked for explicit reconciliation.

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_performance_scoped_identity
  ON content_performance(id, tenant_id, owner_user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_artifacts_scoped_item_identity
  ON content_artifacts(id, tenant_id, owner_user_id, item_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_revisions_scoped_artifact_identity
  ON content_revisions(id, tenant_id, owner_user_id, artifact_id);

CREATE TABLE IF NOT EXISTS content_performance_workspace_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  owner_user_id INTEGER NOT NULL CHECK (owner_user_id > 0),
  performance_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  artifact_id INTEGER NOT NULL,
  revision_id INTEGER NOT NULL,
  origin TEXT NOT NULL
    CHECK (origin IN ('legacy_pipeline_backfill', 'canonical_api')),
  schema_version TEXT NOT NULL DEFAULT 'content-performance-lineage-v1'
    CHECK (schema_version = 'content-performance-lineage-v1'),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, owner_user_id, performance_id),
  FOREIGN KEY (performance_id, tenant_id, owner_user_id)
    REFERENCES content_performance(id, tenant_id, owner_user_id)
    ON DELETE CASCADE,
  FOREIGN KEY (item_id, tenant_id, owner_user_id)
    REFERENCES content_domain_objects(id, tenant_id, owner_user_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (artifact_id, tenant_id, owner_user_id, item_id)
    REFERENCES content_artifacts(id, tenant_id, owner_user_id, item_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (revision_id, tenant_id, owner_user_id, artifact_id)
    REFERENCES content_revisions(id, tenant_id, owner_user_id, artifact_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_content_performance_workspace_links_item
  ON content_performance_workspace_links(
    tenant_id,
    owner_user_id,
    item_id,
    created_at DESC
  );

CREATE INDEX IF NOT EXISTS idx_content_performance_workspace_links_revision
  ON content_performance_workspace_links(
    tenant_id,
    owner_user_id,
    revision_id,
    created_at DESC
  );

CREATE TRIGGER IF NOT EXISTS trg_content_performance_workspace_links_scope_insert
BEFORE INSERT ON content_performance_workspace_links
BEGIN
  SELECT RAISE(ABORT, 'content performance outcome scope mismatch')
    WHERE NOT EXISTS (
      SELECT 1
        FROM content_performance AS performance
       WHERE performance.id = NEW.performance_id
         AND performance.tenant_id = NEW.tenant_id
         AND performance.owner_user_id = NEW.owner_user_id
         AND performance.user_id = NEW.owner_user_id
         AND performance.visibility_scope = 'user_private'
         AND performance.scope_status = 'active'
    );
  SELECT RAISE(ABORT, 'content performance item scope mismatch')
    WHERE NOT EXISTS (
      SELECT 1
        FROM content_domain_objects AS item
       WHERE item.id = NEW.item_id
         AND item.tenant_id = NEW.tenant_id
         AND item.owner_user_id = NEW.owner_user_id
         AND item.visibility_scope = 'user_private'
         AND item.scope_status = 'active'
         AND item.object_type = 'content_item'
    );
  SELECT RAISE(ABORT, 'content performance artifact scope mismatch')
    WHERE NOT EXISTS (
      SELECT 1
        FROM content_artifacts AS artifact
       WHERE artifact.id = NEW.artifact_id
         AND artifact.item_id = NEW.item_id
         AND artifact.tenant_id = NEW.tenant_id
         AND artifact.owner_user_id = NEW.owner_user_id
         AND artifact.visibility_scope = 'user_private'
         AND artifact.scope_status = 'active'
    );
  SELECT RAISE(ABORT, 'content performance revision scope mismatch')
    WHERE NOT EXISTS (
      SELECT 1
        FROM content_revisions AS revision
       WHERE revision.id = NEW.revision_id
         AND revision.artifact_id = NEW.artifact_id
         AND revision.tenant_id = NEW.tenant_id
         AND revision.owner_user_id = NEW.owner_user_id
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_content_performance_workspace_links_immutable
BEFORE UPDATE ON content_performance_workspace_links
BEGIN
  SELECT RAISE(ABORT, 'content performance lineage is immutable');
END;

INSERT OR IGNORE INTO content_performance_workspace_links (
  tenant_id,
  owner_user_id,
  performance_id,
  item_id,
  artifact_id,
  revision_id,
  origin
)
SELECT
  performance.tenant_id,
  performance.owner_user_id,
  performance.id,
  binding.item_id,
  binding.artifact_id,
  binding.revision_id,
  'legacy_pipeline_backfill'
FROM content_performance AS performance
JOIN content_workspace_ingress_bindings AS binding
  ON binding.tenant_id = performance.tenant_id
 AND binding.owner_user_id = performance.owner_user_id
 AND binding.source_kind = 'legacy_pipeline'
 AND binding.source_id = CAST(performance.pipeline_id AS TEXT)
 AND binding.content_parity_status = 'artifact_pinned'
 AND binding.artifact_id IS NOT NULL
 AND binding.revision_id IS NOT NULL
WHERE performance.pipeline_id IS NOT NULL
  AND performance.tenant_id > 0
  AND performance.owner_user_id > 0
  AND performance.user_id = performance.owner_user_id
  AND performance.visibility_scope = 'user_private'
  AND performance.scope_status = 'active';

-- New canonical writers must leave the legacy alias NULL. Existing aliases
-- remain queryable for compatibility and export, but cannot be rewritten.
-- DELETE remains available for scoped account erasure.
CREATE TRIGGER IF NOT EXISTS trg_content_performance_pipeline_alias_insert_blocked
BEFORE INSERT ON content_performance
WHEN NEW.pipeline_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'content_performance.pipeline_id is a frozen legacy alias; use canonical workspace lineage');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_performance_pipeline_alias_update_blocked
BEFORE UPDATE OF pipeline_id ON content_performance
WHEN NEW.pipeline_id IS NOT OLD.pipeline_id
BEGIN
  SELECT RAISE(ABORT, 'content_performance.pipeline_id is a frozen legacy alias; use canonical workspace lineage');
END;
