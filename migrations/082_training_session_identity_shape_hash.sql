-- Migration 082: Training session identity + material shape hash.
--
-- Adds deterministic identity fields used by regenerated Training plans
-- and agenda sync. The logical identity key stays stable for the same
-- plan/week/day/session slot across versions; the shape hash changes only
-- when the coaching structure materially changes. Calendar ownership rows
-- store both so sync can safely update, replace, or delete events without
-- relying on title/date matching.

ALTER TABLE training_sessions
  ADD COLUMN session_identity_key TEXT;

ALTER TABLE training_sessions
  ADD COLUMN session_shape_hash TEXT;

ALTER TABLE training_agenda_event_ownership
  ADD COLUMN session_identity_key TEXT;

ALTER TABLE training_agenda_event_ownership
  ADD COLUMN session_shape_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_training_sessions_identity
  ON training_sessions(plan_id, session_identity_key, session_shape_hash);

CREATE INDEX IF NOT EXISTS idx_training_agenda_ownership_session_identity
  ON training_agenda_event_ownership(plan_id, user_id, session_identity_key, session_shape_hash, status);
