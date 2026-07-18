-- Migration 239 (FORWARD-ONLY): pin Content Agency pipeline handoffs to immutable package bytes.
--
-- Package identifiers remain the compatibility key, while the full SHA-256
-- content hash prevents an approval or pipeline handoff from resolving to a
-- later-mutated payload with the same legacy identifier.
ALTER TABLE content_pipeline ADD COLUMN source_agency_package_hash TEXT;

-- Preserve every historical row but leave only the newest duplicate active
-- before installing the database uniqueness invariant.
UPDATE content_pipeline
   SET scope_status = 'superseded_duplicate'
 WHERE id IN (
   SELECT duplicate.id
     FROM content_pipeline AS duplicate
     JOIN content_pipeline AS keeper
       ON keeper.tenant_id = duplicate.tenant_id
      AND keeper.owner_user_id = duplicate.owner_user_id
      AND keeper.source_agency_package_id = duplicate.source_agency_package_id
      AND keeper.scope_status = 'active'
      AND keeper.id > duplicate.id
    WHERE duplicate.scope_status = 'active'
      AND duplicate.source_agency_package_id IS NOT NULL
 );

DROP INDEX IF EXISTS idx_content_pipeline_agency_package;
CREATE INDEX IF NOT EXISTS idx_content_pipeline_agency_package
  ON content_pipeline(
    tenant_id,
    user_id,
    source_agency_package_id,
    source_agency_package_hash,
    scope_status
  );

CREATE UNIQUE INDEX IF NOT EXISTS uniq_content_pipeline_active_agency_package
  ON content_pipeline(tenant_id, owner_user_id, source_agency_package_id)
  WHERE scope_status = 'active' AND source_agency_package_id IS NOT NULL;
