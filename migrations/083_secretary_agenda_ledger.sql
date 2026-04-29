-- Migration 083: Secretary agenda lifecycle ledger.
--
-- Adds the durable agenda-item ownership table used by Secretary as the
-- schedule/lifecycle authority across skills and calendar providers. The table
-- stores source intent identity, owner/tenant scope, lifecycle state, provider
-- sync metadata, decision reasons, and supersession/cancellation metadata so
-- agenda state can be repaired without title/date matching.

CREATE TABLE IF NOT EXISTS secretary_agenda_items (
  agenda_item_id TEXT PRIMARY KEY,
  source_intent_id TEXT NOT NULL,
  source_skill TEXT NOT NULL,
  source_action TEXT,
  intent_action TEXT NOT NULL DEFAULT 'schedule_this'
    CHECK (intent_action IN (
      'schedule_this',
      'reschedule_this',
      'cancel_this',
      'find_time_for_this',
      'protect_time_for_this',
      'create_reminder',
      'create_follow_up',
      'request_clarification'
    )),
  source_entity_id TEXT,
  source_entity_type TEXT,
  owner_user_id INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL
    CHECK (lifecycle_state IN (
      'proposed',
      'scheduled',
      'synced',
      'reflowed',
      'compressed',
      'deferred',
      'canceled',
      'superseded',
      'unscheduled',
      'failed_sync',
      'completed'
    )),
  provider_sync_state TEXT NOT NULL
    CHECK (provider_sync_state IN (
      'not_synced',
      'synced',
      'create_failed',
      'update_failed',
      'delete_failed',
      'readback_failed',
      'deleted'
    )),
  provider_event_id TEXT,
  provider_source TEXT
    CHECK (provider_source IS NULL OR provider_source IN ('google', 'outlook')),
  version INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  start_at TEXT,
  end_at TEXT,
  duration_minutes INTEGER,
  decision_action TEXT NOT NULL,
  decision_reason_codes_json TEXT NOT NULL DEFAULT '[]',
  source_shape_hash TEXT NOT NULL,
  scheduled_segments_json TEXT NOT NULL DEFAULT '[]',
  cancellation_reason TEXT,
  superseded_by_agenda_item_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  source_created_at TEXT,
  source_updated_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_secretary_agenda_identity
  ON secretary_agenda_items(owner_user_id, tenant_id, source_skill, source_intent_id, version);

CREATE INDEX IF NOT EXISTS idx_secretary_agenda_intent
  ON secretary_agenda_items(owner_user_id, tenant_id, source_skill, source_intent_id);

CREATE INDEX IF NOT EXISTS idx_secretary_agenda_provider_event
  ON secretary_agenda_items(provider_source, provider_event_id);

CREATE INDEX IF NOT EXISTS idx_secretary_agenda_source_entity
  ON secretary_agenda_items(owner_user_id, tenant_id, source_skill, source_entity_type, source_entity_id);

CREATE INDEX IF NOT EXISTS idx_secretary_agenda_user_state
  ON secretary_agenda_items(owner_user_id, tenant_id, lifecycle_state, start_at);
