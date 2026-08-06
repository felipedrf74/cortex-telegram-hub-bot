-- 279: Fence event_outbox and background_jobs leases against stale workers.
--
-- Both queues previously treated locked_at + lock_owner as a reclaim hint but
-- completed/failed rows by id alone. After an expired lease was reclaimed, an
-- older worker could therefore overwrite the new holder's state. A fresh token
-- is assigned on every claim and all renewal/terminal writes compare the full
-- (row id, owner, token, unexpired lease) identity.
--
-- Existing processing rows receive a fresh 15-minute migration grace instead
-- of deriving expiry from a possibly old locked_at. Their token remains NULL:
-- the old worker can finish with the predecessor runtime, while the fenced
-- runtime waits for the full grace before assigning a token on reclaim.

ALTER TABLE event_outbox ADD COLUMN fencing_token TEXT;
ALTER TABLE event_outbox ADD COLUMN lease_expires_at TEXT;

UPDATE event_outbox
   SET lease_expires_at = datetime('now', '+15 minutes')
 WHERE status = 'processing'
   AND lease_expires_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_event_outbox_lease_expiry
  ON event_outbox(status, lease_expires_at);

-- During a rolling deploy, a predecessor worker can still issue the old
-- pending/failed/expired -> processing claim. Reject it before its handler can
-- run: every claim (including processing -> processing reclaims) must rotate
-- the token and install a named, unexpired lease. Tokenless processing rows
-- created before this migration are unaffected until somebody tries to claim
-- them, so their original worker keeps the documented terminal-write grace.
CREATE TRIGGER IF NOT EXISTS trg_event_outbox_fenced_claim_transition
BEFORE UPDATE OF status ON event_outbox
FOR EACH ROW
WHEN NEW.status = 'processing'
  AND NOT (
    NEW.fencing_token IS NOT NULL
    AND NEW.fencing_token IS NOT OLD.fencing_token
    AND NEW.lock_owner IS NOT NULL
    AND length(trim(NEW.lock_owner)) > 0
    AND NEW.locked_at IS NOT NULL
    AND NEW.lease_expires_at IS NOT NULL
    AND NEW.lease_expires_at > datetime('now')
  )
BEGIN
  SELECT RAISE(ABORT, 'EVENT_OUTBOX_FENCING_VIOLATION');
END;

-- A predecessor worker terminal-updates by id/status and cannot name the new
-- lease columns. Require the active token to survive while expiry is cleared;
-- then retain that token as a tombstone so a still-later predecessor write is
-- rejected as well.
CREATE TRIGGER IF NOT EXISTS trg_event_outbox_fenced_terminal_transition
BEFORE UPDATE OF status ON event_outbox
FOR EACH ROW
WHEN OLD.status = 'processing'
  AND OLD.fencing_token IS NOT NULL
  AND NEW.status IN ('processed', 'failed', 'dead_letter')
  AND NOT (
    OLD.lease_expires_at IS NOT NULL
    AND NEW.lease_expires_at IS NULL
    AND NEW.fencing_token IS OLD.fencing_token
  )
BEGIN
  SELECT RAISE(ABORT, 'EVENT_OUTBOX_FENCING_VIOLATION');
END;

CREATE TRIGGER IF NOT EXISTS trg_event_outbox_terminal_tombstone
BEFORE UPDATE OF status ON event_outbox
FOR EACH ROW
WHEN NEW.status IN ('processed', 'failed', 'dead_letter')
  AND OLD.status != 'processing'
BEGIN
  SELECT RAISE(ABORT, 'EVENT_OUTBOX_FENCING_VIOLATION');
END;

ALTER TABLE background_jobs ADD COLUMN fencing_token TEXT;
ALTER TABLE background_jobs ADD COLUMN lease_expires_at TEXT;

UPDATE background_jobs
   SET lease_expires_at = datetime('now', '+15 minutes')
 WHERE status = 'processing'
   AND lease_expires_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_background_jobs_lease_expiry
  ON background_jobs(status, lease_expires_at);

CREATE TRIGGER IF NOT EXISTS trg_background_jobs_fenced_claim_transition
BEFORE UPDATE OF status ON background_jobs
FOR EACH ROW
WHEN NEW.status = 'processing'
  AND NOT (
    NEW.fencing_token IS NOT NULL
    AND NEW.fencing_token IS NOT OLD.fencing_token
    AND NEW.lock_owner IS NOT NULL
    AND length(trim(NEW.lock_owner)) > 0
    AND NEW.locked_at IS NOT NULL
    AND NEW.lease_expires_at IS NOT NULL
    AND NEW.lease_expires_at > datetime('now')
  )
BEGIN
  SELECT RAISE(ABORT, 'BACKGROUND_JOB_FENCING_VIOLATION');
END;

CREATE TRIGGER IF NOT EXISTS trg_background_jobs_fenced_terminal_transition
BEFORE UPDATE OF status ON background_jobs
FOR EACH ROW
WHEN OLD.status = 'processing'
  AND OLD.fencing_token IS NOT NULL
  AND NEW.status IN ('completed', 'failed', 'dead_letter')
  AND NOT (
    OLD.lease_expires_at IS NOT NULL
    AND NEW.lease_expires_at IS NULL
    AND NEW.fencing_token IS OLD.fencing_token
  )
BEGIN
  SELECT RAISE(ABORT, 'BACKGROUND_JOB_FENCING_VIOLATION');
END;

CREATE TRIGGER IF NOT EXISTS trg_background_jobs_terminal_tombstone
BEFORE UPDATE OF status ON background_jobs
FOR EACH ROW
WHEN NEW.status IN ('completed', 'failed', 'dead_letter')
  AND OLD.status != 'processing'
BEGIN
  SELECT RAISE(ABORT, 'BACKGROUND_JOB_FENCING_VIOLATION');
END;
