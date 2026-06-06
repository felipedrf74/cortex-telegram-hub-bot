-- Cooking tenant_id NOT NULL rebuild.
--
-- Migration 102 added tenant_id as nullable columns for legacy compatibility.
-- This pass rebuilds recipes so all Cooking core tables now enforce explicit
-- tenant scope. Meal plans/shopping lists are rebuilt in migration 137 for
-- tenant-aware uniqueness; pantry was created tenant-scoped in migration 104.

PRAGMA foreign_keys=OFF;

CREATE TABLE recipes__tenant_not_null (
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
    title                TEXT NOT NULL,
    ingredients          TEXT NOT NULL,
    instructions         TEXT,
    prep_time_min        INTEGER,
    cook_time_min        INTEGER,
    servings             INTEGER DEFAULT 1,
    protein_g            REAL,
    fat_g                REAL,
    carbs_g              REAL,
    calories_kcal        REAL,
    tags                 TEXT,
    source               TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO recipes__tenant_not_null (
    id, user_id, tenant_id, owner_user_id, visibility_scope, lifecycle_state,
    scope_status, created_by, updated_by, audit_metadata_json, title,
    ingredients, instructions, prep_time_min, cook_time_min, servings,
    protein_g, fat_g, carbs_g, calories_kcal, tags, source, created_at,
    updated_at
)
SELECT
    id,
    user_id,
    COALESCE(NULLIF(tenant_id, 0), user_id),
    COALESCE(NULLIF(owner_user_id, 0), user_id),
    COALESCE(visibility_scope, 'user_private'),
    COALESCE(lifecycle_state, 'active'),
    COALESCE(scope_status, 'active'),
    COALESCE(created_by, user_id),
    COALESCE(updated_by, user_id),
    COALESCE(audit_metadata_json, '{}'),
    title,
    ingredients,
    instructions,
    prep_time_min,
    cook_time_min,
    servings,
    protein_g,
    fat_g,
    carbs_g,
    calories_kcal,
    tags,
    source,
    created_at,
    updated_at
FROM recipes;

DROP TABLE recipes;
ALTER TABLE recipes__tenant_not_null RENAME TO recipes;

CREATE INDEX IF NOT EXISTS idx_recipes_user ON recipes(user_id);
CREATE INDEX IF NOT EXISTS idx_recipes_tags ON recipes(user_id, tags);
CREATE INDEX IF NOT EXISTS idx_recipes_tenant_owner
  ON recipes(tenant_id, owner_user_id, visibility_scope, scope_status, updated_at);

PRAGMA foreign_keys=ON;
