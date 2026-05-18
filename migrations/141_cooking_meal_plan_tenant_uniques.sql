-- Rebuild cooking schedule tables so tenant scope participates in slot
-- uniqueness. Migration 102 added tenant_id, but the original table-level
-- UNIQUE(user_id, ...) constraints still blocked the same user id from
-- holding separate tenant workspaces.

PRAGMA foreign_keys=OFF;

CREATE TABLE meal_plans__tenant_unique (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id              INTEGER NOT NULL,
    tenant_id            INTEGER NOT NULL,
    owner_user_id        INTEGER NOT NULL,
    visibility_scope     TEXT DEFAULT 'user_private',
    lifecycle_state      TEXT DEFAULT 'planned',
    scope_status         TEXT DEFAULT 'active',
    created_by           INTEGER,
    updated_by           INTEGER,
    audit_metadata_json  TEXT DEFAULT '{}',
    date                 TEXT NOT NULL,
    meal_type            TEXT NOT NULL,
    recipe_id            INTEGER,
    title                TEXT NOT NULL,
    notes                TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, user_id, date, meal_type)
);

INSERT INTO meal_plans__tenant_unique (
    id, user_id, tenant_id, owner_user_id, visibility_scope, lifecycle_state,
    scope_status, created_by, updated_by, audit_metadata_json, date, meal_type,
    recipe_id, title, notes, created_at
)
SELECT
    id,
    user_id,
    COALESCE(tenant_id, user_id),
    COALESCE(owner_user_id, user_id),
    COALESCE(visibility_scope, 'user_private'),
    COALESCE(lifecycle_state, 'planned'),
    COALESCE(scope_status, 'active'),
    COALESCE(created_by, user_id),
    COALESCE(updated_by, user_id),
    COALESCE(audit_metadata_json, '{}'),
    date,
    meal_type,
    recipe_id,
    title,
    notes,
    created_at
FROM meal_plans;

DROP TABLE meal_plans;
ALTER TABLE meal_plans__tenant_unique RENAME TO meal_plans;

CREATE INDEX IF NOT EXISTS idx_meal_plans_user ON meal_plans(user_id, date);
CREATE INDEX IF NOT EXISTS idx_meal_plans_tenant_owner
  ON meal_plans(tenant_id, owner_user_id, visibility_scope, scope_status, date);

CREATE TABLE shopping_lists__tenant_unique (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id              INTEGER NOT NULL,
    tenant_id            INTEGER NOT NULL,
    owner_user_id        INTEGER NOT NULL,
    visibility_scope     TEXT DEFAULT 'user_private',
    lifecycle_state      TEXT DEFAULT 'active',
    scope_status         TEXT DEFAULT 'active',
    created_by           INTEGER,
    updated_by           INTEGER,
    audit_metadata_json  TEXT DEFAULT '{}',
    week_start           TEXT NOT NULL,
    items                TEXT NOT NULL DEFAULT '[]',
    status               TEXT NOT NULL DEFAULT 'active',
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, user_id, week_start)
);

INSERT INTO shopping_lists__tenant_unique (
    id, user_id, tenant_id, owner_user_id, visibility_scope, lifecycle_state,
    scope_status, created_by, updated_by, audit_metadata_json, week_start,
    items, status, created_at, updated_at
)
SELECT
    id,
    user_id,
    COALESCE(tenant_id, user_id),
    COALESCE(owner_user_id, user_id),
    COALESCE(visibility_scope, 'user_private'),
    COALESCE(lifecycle_state, 'active'),
    COALESCE(scope_status, 'active'),
    COALESCE(created_by, user_id),
    COALESCE(updated_by, user_id),
    COALESCE(audit_metadata_json, '{}'),
    week_start,
    items,
    status,
    created_at,
    updated_at
FROM shopping_lists;

DROP TABLE shopping_lists;
ALTER TABLE shopping_lists__tenant_unique RENAME TO shopping_lists;

CREATE INDEX IF NOT EXISTS idx_shopping_user ON shopping_lists(user_id, status);
CREATE INDEX IF NOT EXISTS idx_shopping_lists_tenant_owner
  ON shopping_lists(tenant_id, owner_user_id, visibility_scope, scope_status, week_start);

PRAGMA foreign_keys=ON;
