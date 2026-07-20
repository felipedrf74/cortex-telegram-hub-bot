-- Migration 241: Content workspace library metadata and tenant-scoped tags.
--
-- content_domain_objects remains the only item/project root. Tags are scoped
-- child metadata and content_item_relationships continues to model project
-- collections; this migration does not introduce folders or a parallel root.

CREATE TABLE IF NOT EXISTS content_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  owner_user_id INTEGER NOT NULL,
  visibility_scope TEXT NOT NULL DEFAULT 'user_private'
    CHECK (visibility_scope = 'user_private'),
  scope_status TEXT NOT NULL DEFAULT 'active'
    CHECK (scope_status IN ('active', 'archived', 'deleted')),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  normalized_name TEXT NOT NULL CHECK (length(normalized_name) BETWEEN 1 AND 80),
  created_by INTEGER NOT NULL,
  updated_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, owner_user_id, normalized_name),
  UNIQUE(id, tenant_id, owner_user_id)
);

CREATE INDEX IF NOT EXISTS idx_content_tags_library
  ON content_tags(tenant_id, owner_user_id, scope_status, normalized_name, id);

CREATE TABLE IF NOT EXISTS content_item_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  owner_user_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, owner_user_id, item_id, tag_id),
  FOREIGN KEY (item_id, tenant_id, owner_user_id)
    REFERENCES content_domain_objects(id, tenant_id, owner_user_id)
    ON DELETE CASCADE,
  FOREIGN KEY (tag_id, tenant_id, owner_user_id)
    REFERENCES content_tags(id, tenant_id, owner_user_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_content_item_tags_item
  ON content_item_tags(tenant_id, owner_user_id, item_id, tag_id);

CREATE INDEX IF NOT EXISTS idx_content_item_tags_tag
  ON content_item_tags(tenant_id, owner_user_id, tag_id, item_id);

CREATE INDEX IF NOT EXISTS idx_content_workspace_library_sort
  ON content_domain_objects(
    tenant_id,
    owner_user_id,
    scope_status,
    production_state,
    is_favorite,
    workspace_priority,
    updated_at,
    id
  )
  WHERE object_type IN ('content_item', 'project');
