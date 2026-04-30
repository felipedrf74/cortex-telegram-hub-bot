-- Migration 104: Cooking pantry persistence
--
-- Adds tenant-scoped pantry items so Cooking can distinguish "needed" grocery
-- items from ingredients already available at home. Rows are user-private by
-- default and follow the same scope columns as recipes, meal plans, and
-- shopping lists.

CREATE TABLE IF NOT EXISTS cooking_pantry_items (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id           INTEGER NOT NULL,
    user_id             INTEGER NOT NULL,
    owner_user_id       INTEGER NOT NULL,
    visibility_scope    TEXT NOT NULL DEFAULT 'user_private',
    lifecycle_state     TEXT NOT NULL DEFAULT 'available',
    scope_status        TEXT NOT NULL DEFAULT 'active',
    created_by          INTEGER,
    updated_by          INTEGER,
    audit_metadata_json TEXT NOT NULL DEFAULT '{}',
    name                TEXT NOT NULL,
    normalized_name     TEXT NOT NULL,
    quantity            TEXT,
    unit                TEXT,
    category            TEXT,
    expires_at          TEXT,
    freshness_status    TEXT NOT NULL DEFAULT 'unknown',
    availability_status TEXT NOT NULL DEFAULT 'available',
    source              TEXT NOT NULL DEFAULT 'manual',
    confidence          REAL NOT NULL DEFAULT 1.0,
    notes               TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cooking_pantry_scope_name_active
  ON cooking_pantry_items(tenant_id, owner_user_id, normalized_name)
  WHERE scope_status = 'active';

CREATE INDEX IF NOT EXISTS idx_cooking_pantry_tenant_owner
  ON cooking_pantry_items(tenant_id, owner_user_id, visibility_scope, scope_status, availability_status, freshness_status);

CREATE INDEX IF NOT EXISTS idx_cooking_pantry_expiry
  ON cooking_pantry_items(tenant_id, owner_user_id, expires_at);
