-- Migration 129: Content Agency -> pipeline handoff traceability.
--
-- Agency packages move into the existing content_pipeline table after approval.
-- This column keeps the handoff idempotent and auditable without introducing a
-- duplicate content pipeline.

ALTER TABLE content_pipeline ADD COLUMN source_agency_package_id TEXT;

CREATE INDEX IF NOT EXISTS idx_content_pipeline_agency_package
  ON content_pipeline(tenant_id, user_id, source_agency_package_id, scope_status);
