-- Migration 281: pin Secretary provider ownership before any calendar effect.
--
-- `provider_source` is the durable source of an already-adopted event. It is
-- too late to prevent two providers from racing a first create. The separate
-- target is chosen before agenda persistence and is immutable for that agenda
-- version. Failure disposition distinguishes terminal provider refusals from
-- retryable known-no-effect responses and unknown outcomes requiring readback.

ALTER TABLE secretary_agenda_items ADD COLUMN provider_target TEXT
  CHECK (provider_target IS NULL OR provider_target IN ('google', 'outlook'));
ALTER TABLE secretary_agenda_items ADD COLUMN provider_sync_failure_disposition TEXT
  CHECK (
    provider_sync_failure_disposition IS NULL
    OR provider_sync_failure_disposition IN ('terminal', 'retryable', 'reconcile')
  );
ALTER TABLE secretary_agenda_items ADD COLUMN provider_sync_retry_after_at TEXT;

-- Existing adopted mappings already have an authoritative provider. Backfill
-- only those; unowned legacy creates remain unpinned and therefore fail closed
-- until a scoped producer or repair path selects a target.
UPDATE secretary_agenda_items
   SET provider_target = provider_source
 WHERE provider_target IS NULL
   AND provider_source IN ('google', 'outlook');

CREATE INDEX IF NOT EXISTS idx_secretary_agenda_provider_target_pending
  ON secretary_agenda_items(
    provider_target,
    owner_user_id,
    tenant_id,
    provider_sync_state,
    provider_sync_failure_disposition,
    provider_sync_retry_after_at
  );
