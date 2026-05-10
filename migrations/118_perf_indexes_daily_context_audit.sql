-- Wave 1 launch-readiness perf indexes.
-- Daily context is read on every AI context build; audit_trail action views
-- power operator/event forensics during launch drills.

CREATE INDEX IF NOT EXISTS idx_daily_context_lookup
  ON daily_context_cache(tenant_id, user_id, date, scope_status);

CREATE INDEX IF NOT EXISTS idx_audit_action_ts
  ON audit_trail(action, ts DESC);
