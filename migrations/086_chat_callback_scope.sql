-- Tenant-safe callback/action refs for iOS Chat.
--
-- Legacy callback rows were short opaque refs with no user/tenant owner. That
-- is acceptable for older Telegram-only flows that resolve inside a single bot
-- callback context, but iOS Chat callbacks are backend API actions and must be
-- scoped before they can mutate tasks, coach recommendations, or future tools.
--
-- Existing unscoped rows are intentionally quarantined. New iOS refs are stored
-- with tenant_id/user_id and can only be read by the matching authenticated
-- request through getCallbackForScope().

ALTER TABLE callback_entries ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE callback_entries ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE callback_entries ADD COLUMN created_by INTEGER;
ALTER TABLE callback_entries ADD COLUMN visibility_scope TEXT NOT NULL DEFAULT 'system_internal';
ALTER TABLE callback_entries ADD COLUMN scope_status TEXT NOT NULL DEFAULT 'quarantined';
ALTER TABLE callback_entries ADD COLUMN source_message_id TEXT;
ALTER TABLE callback_entries ADD COLUMN action_type TEXT;
ALTER TABLE callback_entries ADD COLUMN consumed_at_ms INTEGER;
ALTER TABLE callback_entries ADD COLUMN last_used_at_ms INTEGER;
ALTER TABLE callback_entries ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0;

UPDATE callback_entries
SET
  visibility_scope = 'system_internal',
  scope_status = 'quarantined'
WHERE tenant_id = 0 OR user_id = 0;

CREATE INDEX IF NOT EXISTS idx_callback_entries_scope_ref
  ON callback_entries(tenant_id, user_id, ref);

CREATE INDEX IF NOT EXISTS idx_callback_entries_scope_status
  ON callback_entries(scope_status, expires_at_ms);

CREATE INDEX IF NOT EXISTS idx_callback_entries_action_scope
  ON callback_entries(tenant_id, user_id, action_type, expires_at_ms);
