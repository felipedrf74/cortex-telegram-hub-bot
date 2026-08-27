-- Compatibility cleanup for any rehearsal database that observed the earlier
-- phase-B candidate. The released phase-A migration creates no triggers.
DROP TRIGGER IF EXISTS content_script_jobs_release_identity_update_guard;
DROP TRIGGER IF EXISTS content_script_jobs_release_identity_insert_guard;

ALTER TABLE content_script_jobs DROP COLUMN completed_release_backend_digest;
ALTER TABLE content_script_jobs DROP COLUMN completed_release_source_sha;
ALTER TABLE content_script_jobs DROP COLUMN completed_release_id;
ALTER TABLE content_script_jobs DROP COLUMN created_release_backend_digest;
ALTER TABLE content_script_jobs DROP COLUMN created_release_source_sha;
ALTER TABLE content_script_jobs DROP COLUMN created_release_id;
