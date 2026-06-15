-- 214: Tenant scope for explicit Training travel windows.
--
-- Travel windows affect planner/read-model adaptation. They must be
-- tenant-scoped so the same user identity represented in multiple
-- tenants cannot leak travel constraints across plans.
--
-- Production note:
-- Existing rows receive tenant_id = NULL. Tenant-scoped reads intentionally
-- ignore those legacy rows until ownership can be proven and safely backfilled.
-- Do not infer tenant ownership for users that belong to multiple tenants.

ALTER TABLE travel_windows
  ADD COLUMN tenant_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_travel_windows_user_tenant_dates
  ON travel_windows(user_id, tenant_id, start_date, end_date);
