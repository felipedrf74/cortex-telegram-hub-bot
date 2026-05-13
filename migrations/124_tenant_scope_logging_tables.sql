-- Tenant scope for operational logging tables.
--
-- api_usage already carries user_id + tenant_id from migrations 029/084; this
-- migration scopes the sibling error tables without backfilling legacy rows.
-- NULL means system/pre-migration or unknown scope.

ALTER TABLE error_log ADD COLUMN user_id INTEGER NULL;
ALTER TABLE error_log ADD COLUMN tenant_id INTEGER NULL;
CREATE INDEX IF NOT EXISTS idx_error_log_tenant_user_ts
  ON error_log(tenant_id, user_id, ts);

ALTER TABLE client_errors ADD COLUMN tenant_id INTEGER NULL;
CREATE INDEX IF NOT EXISTS idx_client_errors_tenant_user_ts
  ON client_errors(tenant_id, user_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_api_usage_tenant_user_ts
  ON api_usage(tenant_id, user_id, ts);
