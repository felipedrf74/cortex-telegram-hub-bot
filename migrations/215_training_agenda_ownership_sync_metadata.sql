-- Migration 215: Calendar sync metadata for Training agenda ownership.
--
-- The ownership table is the durable truth for whether a generated
-- Training session is linked to an external provider event. These fields
-- let read models distinguish a fresh verified link from stale or
-- repair-needed state without relying only on legacy session columns.

ALTER TABLE training_agenda_event_ownership
  ADD COLUMN calendar_id TEXT NOT NULL DEFAULT 'primary';

ALTER TABLE training_agenda_event_ownership
  ADD COLUMN last_verified_at TEXT;

ALTER TABLE training_agenda_event_ownership
  ADD COLUMN sync_version TEXT NOT NULL DEFAULT 'training_calendar_sync_v1';

CREATE INDEX IF NOT EXISTS idx_training_agenda_ownership_provider_calendar
  ON training_agenda_event_ownership(tenant_id, user_id, calendar_source, calendar_id, status);
