-- Roll back migration 279. Safe only after fenced workers are drained.

DROP TRIGGER IF EXISTS trg_event_outbox_terminal_tombstone;
DROP TRIGGER IF EXISTS trg_event_outbox_fenced_terminal_transition;
DROP TRIGGER IF EXISTS trg_event_outbox_fenced_claim_transition;
DROP INDEX IF EXISTS idx_event_outbox_lease_expiry;
ALTER TABLE event_outbox DROP COLUMN lease_expires_at;
ALTER TABLE event_outbox DROP COLUMN fencing_token;

DROP TRIGGER IF EXISTS trg_background_jobs_terminal_tombstone;
DROP TRIGGER IF EXISTS trg_background_jobs_fenced_terminal_transition;
DROP TRIGGER IF EXISTS trg_background_jobs_fenced_claim_transition;
DROP INDEX IF EXISTS idx_background_jobs_lease_expiry;
ALTER TABLE background_jobs DROP COLUMN lease_expires_at;
ALTER TABLE background_jobs DROP COLUMN fencing_token;
