-- Migration 102: Cooking tenant scope and lifecycle metadata
--
-- Existing Cooking tables were user-private and keyed only by user_id. This
-- retrofit makes tenant ownership explicit while preserving current runtime
-- behavior by backfilling tenant_id=owner user_id for legacy rows.

ALTER TABLE recipes ADD COLUMN tenant_id INTEGER;
ALTER TABLE recipes ADD COLUMN owner_user_id INTEGER;
ALTER TABLE recipes ADD COLUMN visibility_scope TEXT DEFAULT 'user_private';
ALTER TABLE recipes ADD COLUMN lifecycle_state TEXT DEFAULT 'active';
ALTER TABLE recipes ADD COLUMN scope_status TEXT DEFAULT 'active';
ALTER TABLE recipes ADD COLUMN created_by INTEGER;
ALTER TABLE recipes ADD COLUMN updated_by INTEGER;
ALTER TABLE recipes ADD COLUMN audit_metadata_json TEXT DEFAULT '{}';

ALTER TABLE meal_plans ADD COLUMN tenant_id INTEGER;
ALTER TABLE meal_plans ADD COLUMN owner_user_id INTEGER;
ALTER TABLE meal_plans ADD COLUMN visibility_scope TEXT DEFAULT 'user_private';
ALTER TABLE meal_plans ADD COLUMN lifecycle_state TEXT DEFAULT 'planned';
ALTER TABLE meal_plans ADD COLUMN scope_status TEXT DEFAULT 'active';
ALTER TABLE meal_plans ADD COLUMN created_by INTEGER;
ALTER TABLE meal_plans ADD COLUMN updated_by INTEGER;
ALTER TABLE meal_plans ADD COLUMN audit_metadata_json TEXT DEFAULT '{}';

ALTER TABLE shopping_lists ADD COLUMN tenant_id INTEGER;
ALTER TABLE shopping_lists ADD COLUMN owner_user_id INTEGER;
ALTER TABLE shopping_lists ADD COLUMN visibility_scope TEXT DEFAULT 'user_private';
ALTER TABLE shopping_lists ADD COLUMN lifecycle_state TEXT DEFAULT 'active';
ALTER TABLE shopping_lists ADD COLUMN scope_status TEXT DEFAULT 'active';
ALTER TABLE shopping_lists ADD COLUMN created_by INTEGER;
ALTER TABLE shopping_lists ADD COLUMN updated_by INTEGER;
ALTER TABLE shopping_lists ADD COLUMN audit_metadata_json TEXT DEFAULT '{}';

UPDATE recipes
SET
  tenant_id = COALESCE(NULLIF(tenant_id, 0), user_id),
  owner_user_id = COALESCE(NULLIF(owner_user_id, 0), user_id),
  visibility_scope = COALESCE(NULLIF(visibility_scope, ''), 'user_private'),
  lifecycle_state = COALESCE(NULLIF(lifecycle_state, ''), 'active'),
  scope_status = CASE
    WHEN user_id > 0 THEN COALESCE(NULLIF(scope_status, ''), 'active')
    ELSE 'quarantined'
  END,
  created_by = COALESCE(NULLIF(created_by, 0), user_id),
  updated_by = COALESCE(NULLIF(updated_by, 0), user_id),
  audit_metadata_json = COALESCE(NULLIF(audit_metadata_json, ''), '{}');

UPDATE meal_plans
SET
  tenant_id = COALESCE(NULLIF(tenant_id, 0), user_id),
  owner_user_id = COALESCE(NULLIF(owner_user_id, 0), user_id),
  visibility_scope = COALESCE(NULLIF(visibility_scope, ''), 'user_private'),
  lifecycle_state = COALESCE(NULLIF(lifecycle_state, ''), 'planned'),
  scope_status = CASE
    WHEN user_id > 0 THEN COALESCE(NULLIF(scope_status, ''), 'active')
    ELSE 'quarantined'
  END,
  created_by = COALESCE(NULLIF(created_by, 0), user_id),
  updated_by = COALESCE(NULLIF(updated_by, 0), user_id),
  audit_metadata_json = COALESCE(NULLIF(audit_metadata_json, ''), '{}');

UPDATE shopping_lists
SET
  tenant_id = COALESCE(NULLIF(tenant_id, 0), user_id),
  owner_user_id = COALESCE(NULLIF(owner_user_id, 0), user_id),
  visibility_scope = COALESCE(NULLIF(visibility_scope, ''), 'user_private'),
  lifecycle_state = COALESCE(NULLIF(lifecycle_state, ''), 'active'),
  scope_status = CASE
    WHEN user_id > 0 THEN COALESCE(NULLIF(scope_status, ''), 'active')
    ELSE 'quarantined'
  END,
  created_by = COALESCE(NULLIF(created_by, 0), user_id),
  updated_by = COALESCE(NULLIF(updated_by, 0), user_id),
  audit_metadata_json = COALESCE(NULLIF(audit_metadata_json, ''), '{}');

CREATE INDEX IF NOT EXISTS idx_recipes_tenant_owner
  ON recipes(tenant_id, owner_user_id, visibility_scope, scope_status, updated_at);

CREATE INDEX IF NOT EXISTS idx_meal_plans_tenant_owner
  ON meal_plans(tenant_id, owner_user_id, visibility_scope, scope_status, date);

CREATE INDEX IF NOT EXISTS idx_shopping_lists_tenant_owner
  ON shopping_lists(tenant_id, owner_user_id, visibility_scope, scope_status, week_start);
