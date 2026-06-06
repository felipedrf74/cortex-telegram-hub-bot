-- Migration 099: Tenant scope for Training agenda ownership.
--
-- Existing ownership rows were user-scoped only. Until true tenant
-- membership tables exist for Training, the safe backfill is tenant_id=user_id:
-- this preserves current single-user workspace behavior while giving every
-- ownership query a tenant discriminator.

ALTER TABLE training_agenda_event_ownership
  ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 0;

UPDATE training_agenda_event_ownership
SET tenant_id = user_id
WHERE tenant_id = 0 OR tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_training_agenda_ownership_tenant_user_status
  ON training_agenda_event_ownership(tenant_id, user_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_training_agenda_ownership_unique_tenant
  ON training_agenda_event_ownership(tenant_id, plan_id, plan_version, calendar_event_id, calendar_source);

