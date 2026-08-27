-- Bind durable Content script jobs to the signed application release that
-- admitted them and the release that committed their successful result.
-- Existing rows remain nullable because the immutable nine-script pre-release
-- inventory predates this server-owned provenance contract.

-- Phase A is deliberately expand-only. The current runtime validates and writes
-- complete immutable triples; acceptance evidence rejects missing/partial
-- identities. Database constraints can follow after the predecessor retires.
ALTER TABLE content_script_jobs ADD COLUMN created_release_id TEXT;

ALTER TABLE content_script_jobs ADD COLUMN created_release_source_sha TEXT;

ALTER TABLE content_script_jobs ADD COLUMN created_release_backend_digest TEXT;

ALTER TABLE content_script_jobs ADD COLUMN completed_release_id TEXT;

ALTER TABLE content_script_jobs ADD COLUMN completed_release_source_sha TEXT;

ALTER TABLE content_script_jobs ADD COLUMN completed_release_backend_digest TEXT;
