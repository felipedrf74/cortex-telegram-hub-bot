-- Migration 237: per-provider-list sync selection (M12 connect flow).
--
-- Records the user's connect-time list selection as an explicit per-(tenant,
-- user, provider, provider_list_id) row with sync_enabled (1 = sync this list,
-- 0 = skip it on import, reconciliation, and provider push). The gate is keyed
-- by the PROVIDER list id (not a nexus_list_id) on purpose: the selection has
-- to be durable BEFORE the list is imported, so it cannot live on
-- task_container_mappings (whose nexus_list_id is NOT NULL and only exists
-- after unified_projects import). Default is "no row = enabled", so old
-- clients that never call POST /tasks/sync/connect keep importing every list —
-- fully backward compatible with the pre-M12 auto-import.
--
-- CREATE TABLE IF NOT EXISTS is inherently re-runnable; the production runner's
-- ADD COLUMN stripper is not needed here.

CREATE TABLE IF NOT EXISTS task_list_sync_selection (
  id               TEXT PRIMARY KEY,
  tenant_id        INTEGER NOT NULL,
  user_id          INTEGER NOT NULL,
  provider         TEXT NOT NULL,
  provider_list_id TEXT NOT NULL,
  sync_enabled     INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, user_id, provider, provider_list_id)
);

CREATE INDEX IF NOT EXISTS idx_task_list_sync_selection_scope
  ON task_list_sync_selection(tenant_id, user_id, provider, sync_enabled);
