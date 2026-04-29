-- Migration 100: Tenant scope for the cross-skill intelligence bus.
--
-- User-scoped signals are backfilled to tenant_id=user_id because the current
-- deployed product maps a user's default workspace to their user id. Legacy
-- rows with no user_id remain tenant_id NULL and are treated as platform/global
-- only; tenant-scoped read paths no longer pull them into active user context.

ALTER TABLE agent_signals
  ADD COLUMN tenant_id INTEGER;

UPDATE agent_signals
SET tenant_id = user_id
WHERE user_id IS NOT NULL
  AND (tenant_id IS NULL OR tenant_id = 0);

CREATE INDEX IF NOT EXISTS idx_signals_tenant_user_type
  ON agent_signals (tenant_id, user_id, signal_type)
  WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_signals_tenant_status_type
  ON agent_signals (tenant_id, status, signal_type, created_at DESC);

