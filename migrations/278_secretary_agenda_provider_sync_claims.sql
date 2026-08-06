-- Migration 278: cluster-safe Secretary agenda provider-sync claims.
--
-- Provider calls happen outside SQLite transactions. This durable lease
-- ledger claims one logical intent (across agenda versions) for one
-- owner/tenant/provider before any external effect. The desired fingerprint
-- and authoritative agenda row are revalidated around every provider call.

CREATE TABLE IF NOT EXISTS secretary_agenda_provider_sync_claims (
  owner_user_id INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  provider_source TEXT NOT NULL CHECK (provider_source IN ('google', 'outlook')),
  source_skill TEXT NOT NULL,
  source_intent_id TEXT NOT NULL,
  agenda_item_id TEXT NOT NULL,
  agenda_version INTEGER NOT NULL,
  desired_fingerprint TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (
    owner_user_id, tenant_id, provider_source, source_skill, source_intent_id
  )
);

CREATE INDEX IF NOT EXISTS idx_secretary_provider_sync_claim_scope
  ON secretary_agenda_provider_sync_claims(
    owner_user_id,
    tenant_id,
    provider_source,
    source_skill,
    source_intent_id,
    lease_expires_at
  );

-- A provider create that returned an event id is a known external effect.
-- Record that id before attempting the local mapping transaction so a late
-- lease loss or local SQLite failure can never turn it into an orphan.
CREATE TABLE IF NOT EXISTS secretary_agenda_provider_effect_recovery (
  recovery_id TEXT PRIMARY KEY,
  owner_user_id INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  provider_source TEXT NOT NULL CHECK (provider_source IN ('google', 'outlook')),
  source_skill TEXT NOT NULL,
  source_intent_id TEXT NOT NULL,
  agenda_item_id TEXT NOT NULL,
  agenda_version INTEGER NOT NULL,
  desired_fingerprint TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  effect_kind TEXT NOT NULL CHECK (effect_kind IN ('create', 'update', 'adopt')),
  resolution_state TEXT NOT NULL
    CHECK (resolution_state IN ('pending', 'adopted', 'deleted', 'no_effect')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Resolved history is retained for audit, but only one unresolved mutation may
-- own an exact provider id at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_secretary_provider_effect_recovery_pending_event
  ON secretary_agenda_provider_effect_recovery(
    owner_user_id, tenant_id, provider_source, provider_event_id
  )
  WHERE resolution_state = 'pending';

CREATE INDEX IF NOT EXISTS idx_secretary_provider_effect_recovery_intent
  ON secretary_agenda_provider_effect_recovery(
    owner_user_id, tenant_id, provider_source, source_skill, source_intent_id,
    resolution_state, created_at
  );

-- Timeouts, resets, and 5xx-after-send have an unknown create outcome. This
-- ledger forces future passes into marker readback until the ambiguity is
-- resolved; automatic create is prohibited while an unresolved row exists.
CREATE TABLE IF NOT EXISTS secretary_agenda_provider_create_reconciliation (
  attempt_id TEXT PRIMARY KEY,
  owner_user_id INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  provider_source TEXT NOT NULL CHECK (provider_source IN ('google', 'outlook')),
  source_skill TEXT NOT NULL,
  source_intent_id TEXT NOT NULL,
  agenda_item_id TEXT NOT NULL,
  agenda_version INTEGER NOT NULL,
  desired_fingerprint TEXT NOT NULL,
  provider_event_id TEXT,
  resolution_state TEXT NOT NULL
    CHECK (resolution_state IN (
      'in_flight', 'unknown', 'known', 'attached', 'deleted', 'superseded', 'no_effect'
    )),
  first_observed_at TEXT NOT NULL,
  last_checked_at TEXT,
  resolved_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_secretary_provider_create_reconciliation_intent
  ON secretary_agenda_provider_create_reconciliation(
    owner_user_id, tenant_id, provider_source, source_skill, source_intent_id,
    resolution_state, first_observed_at, attempt_id
  );
