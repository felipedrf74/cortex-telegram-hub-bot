-- 298: durable invoice payload identity and filesystem-deletion journal.
--
-- Keep the base ownership schema and the later identity journal in separately
-- reviewable append-only steps. Both phases remain safe for predecessor code.

ALTER TABLE invoice_artifact_manifests ADD COLUMN write_intent_kind TEXT;
ALTER TABLE invoice_artifact_manifests ADD COLUMN write_intent_id TEXT;
ALTER TABLE invoice_artifact_manifests ADD COLUMN source_checksum TEXT;
ALTER TABLE invoice_artifact_manifests ADD COLUMN payload_checksum TEXT;
ALTER TABLE invoice_artifact_manifests ADD COLUMN payload_bytes INTEGER;
ALTER TABLE invoice_artifact_manifests ADD COLUMN payload_mime TEXT;
ALTER TABLE invoice_artifact_manifests ADD COLUMN deletion_device TEXT;
ALTER TABLE invoice_artifact_manifests ADD COLUMN deletion_inode TEXT;
ALTER TABLE invoice_artifact_manifests ADD COLUMN deletion_attempted_at TEXT;

-- Phase A keeps this a predecessor-compatible lookup index. The application
-- serializes and rejects duplicate live intents under BEGIN IMMEDIATE; a later
-- contract migration may add database uniqueness after the predecessor retires.
CREATE INDEX IF NOT EXISTS idx_invoice_artifact_manifest_write_intent
  ON invoice_artifact_manifests(
    tenant_id,
    user_id,
    write_intent_kind,
    write_intent_id,
    source_checksum,
    artifact_kind,
    deleted_at
  );
