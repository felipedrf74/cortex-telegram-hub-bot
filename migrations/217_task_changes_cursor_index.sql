-- Migration 217: Index offline-first task delta cursor scans.
--
-- The changes endpoint pages by local read-model freshness and Nexus task id.
-- Keep this additive and SQLite-safe for retryable deploy migration runs.

CREATE INDEX IF NOT EXISTS idx_unified_tasks_changes
  ON unified_tasks(tenant_id, user_id, updated_at, nexus_task_id);
