-- Compatibility cleanup for any rehearsal database that observed the earlier
-- phase-B candidate before migration 298 was reduced to expand-only SQL.
DROP TRIGGER IF EXISTS invoice_artifact_manifest_deletion_proof_guard;
DROP INDEX IF EXISTS idx_invoice_artifact_manifest_write_intent;
ALTER TABLE invoice_artifact_manifests DROP COLUMN deletion_attempted_at;
ALTER TABLE invoice_artifact_manifests DROP COLUMN deletion_inode;
ALTER TABLE invoice_artifact_manifests DROP COLUMN deletion_device;
ALTER TABLE invoice_artifact_manifests DROP COLUMN payload_mime;
ALTER TABLE invoice_artifact_manifests DROP COLUMN payload_bytes;
ALTER TABLE invoice_artifact_manifests DROP COLUMN payload_checksum;
ALTER TABLE invoice_artifact_manifests DROP COLUMN source_checksum;
ALTER TABLE invoice_artifact_manifests DROP COLUMN write_intent_id;
ALTER TABLE invoice_artifact_manifests DROP COLUMN write_intent_kind;
