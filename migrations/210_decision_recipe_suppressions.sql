-- Decision Center per-recipe suppression preferences.
--
-- Complements decision_type_suppressions: source/type rows remain broad
-- suppressions, while this table lets a user snooze or hide one recipe within
-- a type without muting every decision of that type.

CREATE TABLE IF NOT EXISTS decision_recipe_suppressions (
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  source_skill TEXT NOT NULL,
  type TEXT NOT NULL,
  recipe TEXT NOT NULL,
  mode TEXT NOT NULL,
  until TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, tenant_id, source_skill, type, recipe)
);

CREATE INDEX IF NOT EXISTS idx_decision_recipe_suppressions_scope
  ON decision_recipe_suppressions(user_id, tenant_id, source_skill, type);
