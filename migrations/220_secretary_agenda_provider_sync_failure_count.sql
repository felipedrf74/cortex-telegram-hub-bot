-- 220: Bounded provider-sync retry for secretary agenda cleanup.
-- Adds a consecutive-failure counter so permanently failing provider
-- deletes stop churning the 5-minute sync loop once the dead-letter
-- threshold is reached, instead of retrying forever. The counter is
-- incremented on failed sync states and reset to 0 on any successful
-- 'synced'/'deleted' transition. Rows at/over the threshold keep their
-- truthful 'delete_failed' state (no new enum value; clients unaffected)
-- and are skipped by the sync loop until the counter is manually reset.
ALTER TABLE secretary_agenda_items ADD COLUMN provider_sync_failure_count INTEGER NOT NULL DEFAULT 0;
