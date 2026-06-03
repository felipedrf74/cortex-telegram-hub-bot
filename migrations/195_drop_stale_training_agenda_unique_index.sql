-- Migration 195: Drop stale non-tenant training agenda ownership uniqueness.
--
-- Migration 099 introduced tenant-aware uniqueness:
--   idx_training_agenda_ownership_unique_tenant
-- The older 081 unique index omits tenant_id and can block the same provider
-- event identity from being represented independently across tenants.

DROP INDEX IF EXISTS idx_training_agenda_ownership_unique;
