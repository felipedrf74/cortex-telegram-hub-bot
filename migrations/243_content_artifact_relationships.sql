-- Migration 243: relationships between canonical Content artifacts.
-- Platform variants live beside their source artifact under one content item;
-- this table preserves that connection without overwriting either artifact.

CREATE TABLE IF NOT EXISTS content_artifact_relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  owner_user_id INTEGER NOT NULL,
  from_artifact_id INTEGER NOT NULL,
  to_artifact_id INTEGER NOT NULL,
  relationship_type TEXT NOT NULL
    CHECK (relationship_type IN ('variant_of', 'derived_from', 'remix_of')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (from_artifact_id <> to_artifact_id),
  UNIQUE (tenant_id, owner_user_id, from_artifact_id, to_artifact_id, relationship_type),
  FOREIGN KEY (from_artifact_id, tenant_id, owner_user_id)
    REFERENCES content_artifacts(id, tenant_id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (to_artifact_id, tenant_id, owner_user_id)
    REFERENCES content_artifacts(id, tenant_id, owner_user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_content_artifact_relationships_from
  ON content_artifact_relationships(tenant_id, owner_user_id, from_artifact_id, relationship_type);

CREATE INDEX IF NOT EXISTS idx_content_artifact_relationships_to
  ON content_artifact_relationships(tenant_id, owner_user_id, to_artifact_id, relationship_type);

CREATE TRIGGER IF NOT EXISTS trg_content_artifact_relationships_same_item_variant
BEFORE INSERT ON content_artifact_relationships
WHEN NEW.relationship_type = 'variant_of'
 AND NOT EXISTS (
   SELECT 1
     FROM content_artifacts variant
     JOIN content_artifacts source
       ON source.id = NEW.to_artifact_id
      AND source.tenant_id = NEW.tenant_id
      AND source.owner_user_id = NEW.owner_user_id
    WHERE variant.id = NEW.from_artifact_id
      AND variant.tenant_id = NEW.tenant_id
      AND variant.owner_user_id = NEW.owner_user_id
      AND variant.item_id = source.item_id
      AND variant.artifact_type = 'platform_variant'
 )
BEGIN
  SELECT RAISE(ABORT, 'platform variants must remain with their source content item');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_artifact_relationships_immutable
BEFORE UPDATE ON content_artifact_relationships
BEGIN
  SELECT RAISE(ABORT, 'content artifact relationships are immutable');
END;
