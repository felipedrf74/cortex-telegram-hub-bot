-- Chat tenant scope hardening.
--
-- Current Nexus canonical tenant identity is users.id, so existing data is
-- backfilled as tenant_id = user_id. The explicit tenant column prevents Chat
-- storage from depending on "user id only" assumptions as workspace/tenant
-- selection grows beyond one canonical tenant per authenticated user.

ALTER TABLE messages ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 0;
UPDATE messages SET tenant_id = user_id WHERE tenant_id = 0;

ALTER TABLE messages ADD COLUMN visibility_scope TEXT NOT NULL DEFAULT 'user_private';
ALTER TABLE messages ADD COLUMN scope_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE messages ADD COLUMN created_by INTEGER;
UPDATE messages
SET
  created_by = CASE WHEN user_id > 0 THEN user_id ELSE NULL END,
  visibility_scope = CASE WHEN user_id > 0 AND tenant_id > 0 THEN 'user_private' ELSE 'system_internal' END,
  scope_status = CASE WHEN user_id > 0 AND tenant_id > 0 THEN 'active' ELSE 'quarantined' END;

CREATE INDEX IF NOT EXISTS idx_messages_tenant_user_created_at
  ON messages(tenant_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_tenant_user_uuid
  ON messages(tenant_id, user_id, message_uuid);

CREATE INDEX IF NOT EXISTS idx_messages_tenant_user_scope
  ON messages(tenant_id, user_id, scope_status, visibility_scope);

ALTER TABLE conversations ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 0;
UPDATE conversations SET tenant_id = user_id WHERE tenant_id = 0;

ALTER TABLE conversations ADD COLUMN visibility_scope TEXT NOT NULL DEFAULT 'user_private';
ALTER TABLE conversations ADD COLUMN scope_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE conversations ADD COLUMN created_by INTEGER;
UPDATE conversations
SET
  created_by = CASE WHEN user_id > 0 THEN user_id ELSE NULL END,
  visibility_scope = CASE WHEN user_id > 0 AND tenant_id > 0 THEN 'user_private' ELSE 'system_internal' END,
  scope_status = CASE WHEN user_id > 0 AND tenant_id > 0 THEN 'active' ELSE 'quarantined' END;

CREATE INDEX IF NOT EXISTS idx_conversations_tenant_user_domain
  ON conversations(tenant_id, user_id, domain, created_at);

CREATE INDEX IF NOT EXISTS idx_conversations_tenant_user_scope
  ON conversations(tenant_id, user_id, scope_status, visibility_scope);

DROP TRIGGER IF EXISTS limit_conversations;

CREATE TRIGGER IF NOT EXISTS limit_conversations
AFTER INSERT ON conversations
BEGIN
  DELETE FROM conversations
  WHERE tenant_id = NEW.tenant_id
    AND user_id = NEW.user_id
    AND domain = NEW.domain
    AND scope_status = 'active'
    AND id NOT IN (
      SELECT id FROM conversations
      WHERE tenant_id = NEW.tenant_id
        AND user_id = NEW.user_id
        AND domain = NEW.domain
        AND scope_status = 'active'
      ORDER BY created_at DESC
      LIMIT 20
    );
END;

ALTER TABLE shared_memory ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 0;
UPDATE shared_memory SET tenant_id = user_id WHERE tenant_id = 0;

CREATE TABLE IF NOT EXISTS shared_memory_scoped_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER NOT NULL DEFAULT 0,
  visibility_scope TEXT NOT NULL DEFAULT 'user_private',
  scope_status TEXT NOT NULL DEFAULT 'active',
  created_by INTEGER,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source_domain TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(tenant_id, user_id, key)
);

INSERT OR IGNORE INTO shared_memory_scoped_new (
  id,
  tenant_id,
  user_id,
  visibility_scope,
  scope_status,
  created_by,
  key,
  value,
  source_domain,
  expires_at,
  created_at,
  updated_at
)
SELECT
  id,
  tenant_id,
  user_id,
  CASE WHEN user_id > 0 AND tenant_id > 0 THEN 'user_private' ELSE 'system_internal' END,
  CASE WHEN user_id > 0 AND tenant_id > 0 THEN 'active' ELSE 'quarantined' END,
  CASE WHEN user_id > 0 THEN user_id ELSE NULL END,
  key,
  value,
  source_domain,
  expires_at,
  created_at,
  updated_at
FROM shared_memory;

DROP TABLE IF EXISTS shared_memory;
ALTER TABLE shared_memory_scoped_new RENAME TO shared_memory;

CREATE INDEX IF NOT EXISTS idx_shared_memory_tenant_user
  ON shared_memory(tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_shared_memory_tenant_user_scope
  ON shared_memory(tenant_id, user_id, scope_status, visibility_scope);

CREATE TABLE IF NOT EXISTS daily_context_cache_scoped_new (
  tenant_id       INTEGER NOT NULL DEFAULT 0,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_status    TEXT NOT NULL DEFAULT 'active',
  date            TEXT NOT NULL,
  context_summary TEXT NOT NULL,
  built_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, user_id, date)
);

INSERT OR IGNORE INTO daily_context_cache_scoped_new (
  tenant_id,
  user_id,
  scope_status,
  date,
  context_summary,
  built_at
)
SELECT
  CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
  user_id,
  CASE WHEN user_id > 0 THEN 'active' ELSE 'quarantined' END,
  date,
  context_summary,
  built_at
FROM daily_context_cache;

DROP TABLE IF EXISTS daily_context_cache;
ALTER TABLE daily_context_cache_scoped_new RENAME TO daily_context_cache;

CREATE INDEX IF NOT EXISTS idx_daily_context_tenant_user
  ON daily_context_cache(tenant_id, user_id, date);

CREATE INDEX IF NOT EXISTS idx_daily_context_built_at
  ON daily_context_cache (built_at);

ALTER TABLE api_usage ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 0;
UPDATE api_usage SET tenant_id = user_id WHERE tenant_id = 0 AND user_id > 0;
CREATE INDEX IF NOT EXISTS idx_api_usage_tenant_user_ts
  ON api_usage(tenant_id, user_id, ts);

ALTER TABLE audit_trail ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 0;
UPDATE audit_trail SET tenant_id = user_id WHERE tenant_id = 0 AND user_id > 0;
CREATE INDEX IF NOT EXISTS idx_audit_trail_tenant_user_ts
  ON audit_trail(tenant_id, user_id, ts);
