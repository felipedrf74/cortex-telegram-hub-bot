-- Migration 200 -- content creation Phase 0 rollout guards.
--
-- CONTENT-NEW-1: content_radar_preferences was originally keyed by user_id,
-- which prevents the same owner from having different radar preferences in
-- two tenants. Rebuild it with a durable tenant+owner key.
--
-- CONT-NEW-5: make active radar feedback idempotent per signal/action so
-- retries and double taps do not inflate ranker input. Keep archived rows
-- available for audit/revoke history.

CREATE TABLE IF NOT EXISTS content_radar_preferences__tenant_owner (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id              INTEGER NOT NULL,
  topics_json          TEXT NOT NULL DEFAULT '[]',
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  tenant_id            INTEGER NOT NULL,
  owner_user_id        INTEGER NOT NULL,
  visibility_scope     TEXT NOT NULL DEFAULT 'user_private',
  lifecycle_state      TEXT NOT NULL DEFAULT 'active',
  scope_status         TEXT NOT NULL DEFAULT 'active',
  created_by           INTEGER NOT NULL,
  updated_by           INTEGER NOT NULL,
  audit_metadata_json  TEXT NOT NULL DEFAULT '{}',
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, owner_user_id)
);

INSERT OR IGNORE INTO content_radar_preferences__tenant_owner (
  user_id, topics_json, updated_at, tenant_id, owner_user_id, visibility_scope,
  lifecycle_state, scope_status, created_by, updated_by, audit_metadata_json,
  created_at
)
SELECT
  CASE WHEN user_id > 0 THEN user_id ELSE COALESCE(owner_user_id, 0) END AS user_id,
  COALESCE(topics_json, '[]') AS topics_json,
  COALESCE(updated_at, datetime('now')) AS updated_at,
  COALESCE(tenant_id, CASE WHEN user_id > 0 THEN user_id ELSE 0 END) AS tenant_id,
  COALESCE(owner_user_id, CASE WHEN user_id > 0 THEN user_id ELSE 0 END) AS owner_user_id,
  COALESCE(visibility_scope, CASE WHEN user_id > 0 THEN 'user_private' ELSE 'platform_internal' END) AS visibility_scope,
  COALESCE(lifecycle_state, 'active') AS lifecycle_state,
  COALESCE(scope_status, CASE WHEN user_id > 0 THEN 'active' ELSE 'quarantined' END) AS scope_status,
  COALESCE(created_by, CASE WHEN user_id > 0 THEN user_id ELSE 0 END) AS created_by,
  COALESCE(updated_by, CASE WHEN user_id > 0 THEN user_id ELSE 0 END) AS updated_by,
  COALESCE(audit_metadata_json, '{}') AS audit_metadata_json,
  COALESCE(updated_at, datetime('now')) AS created_at
FROM content_radar_preferences
WHERE COALESCE(tenant_id, CASE WHEN user_id > 0 THEN user_id ELSE 0 END) > 0
  AND COALESCE(owner_user_id, CASE WHEN user_id > 0 THEN user_id ELSE 0 END) > 0;

DROP TABLE content_radar_preferences;
ALTER TABLE content_radar_preferences__tenant_owner RENAME TO content_radar_preferences;

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_radar_preferences_tenant_owner
  ON content_radar_preferences(tenant_id, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_content_radar_preferences_tenant_scope
  ON content_radar_preferences(tenant_id, owner_user_id, visibility_scope, scope_status);

UPDATE content_topics
   SET tenant_id = COALESCE(tenant_id, CASE WHEN user_id > 0 THEN user_id ELSE 0 END),
       owner_user_id = COALESCE(owner_user_id, CASE WHEN user_id > 0 THEN user_id ELSE 0 END),
       visibility_scope = COALESCE(visibility_scope, CASE WHEN user_id > 0 THEN 'user_private' ELSE 'platform_internal' END),
       lifecycle_state = COALESCE(lifecycle_state, COALESCE(status, 'planned')),
       scope_status = COALESCE(scope_status, CASE WHEN user_id > 0 THEN 'active' ELSE 'quarantined' END),
       created_by = COALESCE(created_by, CASE WHEN user_id > 0 THEN user_id ELSE 0 END),
       updated_by = COALESCE(updated_by, CASE WHEN user_id > 0 THEN user_id ELSE 0 END),
       audit_metadata_json = COALESCE(audit_metadata_json, '{}')
 WHERE tenant_id IS NULL
    OR owner_user_id IS NULL
    OR visibility_scope IS NULL
    OR scope_status IS NULL
    OR created_by IS NULL
    OR updated_by IS NULL
    OR audit_metadata_json IS NULL;

DELETE FROM content_radar_feedback
 WHERE COALESCE(scope_status, 'active') = 'active'
   AND id NOT IN (
     SELECT MAX(id)
       FROM content_radar_feedback
      WHERE COALESCE(scope_status, 'active') = 'active'
      GROUP BY tenant_id, owner_user_id, signal_id, action
   );

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_radar_feedback_active_unique_action
  ON content_radar_feedback(tenant_id, owner_user_id, signal_id, action)
  WHERE scope_status = 'active';
