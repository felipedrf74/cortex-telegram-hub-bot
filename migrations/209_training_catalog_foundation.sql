-- 209: Training catalog foundation.
--
-- Adds versioned, QA-gated catalog tables for coach-kernel exercise
-- and equipment knowledge. This is intentionally additive and does
-- not move live generation to DB-backed selection by itself.
--
-- SQLite notes:
--   - JSON arrays/objects are stored as TEXT with json_valid checks.
--   - Version activation uses a scope key; global rows use '__global__'.
--   - Active catalog content is immutable. Lifecycle status may change
--     for promotion/rollback bookkeeping, but source/content fields may
--     not be rewritten after activation.

CREATE TABLE IF NOT EXISTS training_catalog_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  catalog_version TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT '__global__',
  status TEXT NOT NULL CHECK (status IN ('draft', 'staged', 'active', 'deprecated', 'rolled_back')),
  source_type TEXT NOT NULL CHECK (source_type IN ('repo_seed', 'coach_curated', 'admin_added', 'tenant_override', 'imported')),
  source_hash TEXT NOT NULL,
  parent_catalog_version TEXT,
  science_policy_version TEXT NOT NULL,
  selector_policy_version TEXT NOT NULL,
  equipment_vocabulary_version TEXT NOT NULL,
  generation_pipeline_version TEXT NOT NULL,
  validation_status TEXT NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('pending', 'passed', 'failed')),
  validation_results_json TEXT CHECK (validation_results_json IS NULL OR json_valid(validation_results_json)),
  immutable_after_activation INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  activated_at TEXT,
  deprecated_at TEXT,
  UNIQUE (scope_key, catalog_version)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_training_catalog_versions_one_active_scope
  ON training_catalog_versions(scope_key)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_training_catalog_versions_scope_status
  ON training_catalog_versions(scope_key, status, created_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_training_catalog_versions_active_content_immutable
BEFORE UPDATE ON training_catalog_versions
WHEN OLD.status = 'active'
 AND (
   NEW.catalog_version <> OLD.catalog_version OR
   NEW.scope_key <> OLD.scope_key OR
   NEW.source_type <> OLD.source_type OR
   NEW.source_hash <> OLD.source_hash OR
   COALESCE(NEW.parent_catalog_version, '') <> COALESCE(OLD.parent_catalog_version, '') OR
   NEW.science_policy_version <> OLD.science_policy_version OR
   NEW.selector_policy_version <> OLD.selector_policy_version OR
   NEW.equipment_vocabulary_version <> OLD.equipment_vocabulary_version OR
   NEW.generation_pipeline_version <> OLD.generation_pipeline_version OR
   COALESCE(NEW.validation_results_json, '') <> COALESCE(OLD.validation_results_json, '')
 )
BEGIN
  SELECT RAISE(ABORT, 'active training catalog version content is immutable');
END;

CREATE TABLE IF NOT EXISTS training_equipment_catalog_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  catalog_version TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT '__global__',
  equipment_id TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  aliases_json TEXT NOT NULL CHECK (json_valid(aliases_json)),
  category TEXT NOT NULL CHECK (category IN (
    'bodyweight',
    'free_weight',
    'barbell',
    'dumbbell',
    'kettlebell',
    'machine',
    'cable',
    'band',
    'cardio_machine',
    'pool',
    'bike',
    'space',
    'bench',
    'rack',
    'mobility',
    'other'
  )),
  metadata_confidence TEXT NOT NULL DEFAULT 'curated' CHECK (metadata_confidence IN ('curated', 'inferred', 'unknown')),
  source TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (catalog_version, scope_key, equipment_id)
);

CREATE INDEX IF NOT EXISTS idx_training_equipment_catalog_items_version_active
  ON training_equipment_catalog_items(catalog_version, scope_key, active, equipment_id);

CREATE TRIGGER IF NOT EXISTS trg_training_equipment_catalog_items_active_immutable_update
BEFORE UPDATE ON training_equipment_catalog_items
WHEN EXISTS (
  SELECT 1
    FROM training_catalog_versions v
   WHERE v.catalog_version = OLD.catalog_version
     AND v.scope_key = OLD.scope_key
     AND v.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'active training catalog equipment rows are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_training_equipment_catalog_items_active_immutable_delete
BEFORE DELETE ON training_equipment_catalog_items
WHEN EXISTS (
  SELECT 1
    FROM training_catalog_versions v
   WHERE v.catalog_version = OLD.catalog_version
     AND v.scope_key = OLD.scope_key
     AND v.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'active training catalog equipment rows are immutable');
END;

CREATE TABLE IF NOT EXISTS training_exercise_catalog_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  catalog_version TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT '__global__',
  exercise_id TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  display_names_json TEXT NOT NULL CHECK (json_valid(display_names_json)),
  aliases_json TEXT NOT NULL CHECK (json_valid(aliases_json)),
  modality TEXT NOT NULL CHECK (modality IN (
    'strength',
    'mobility',
    'warmup',
    'cooldown',
    'prehab',
    'run',
    'bike',
    'swim',
    'cardio',
    'skill',
    'recovery'
  )),
  movement_pattern TEXT NOT NULL,
  primary_muscles_json TEXT NOT NULL CHECK (json_valid(primary_muscles_json)),
  secondary_muscles_json TEXT NOT NULL CHECK (json_valid(secondary_muscles_json)),
  joint_actions_json TEXT NOT NULL CHECK (json_valid(joint_actions_json)),
  plane_of_motion TEXT NOT NULL CHECK (plane_of_motion IN ('sagittal', 'frontal', 'transverse', 'multi')),
  equipment_requirements_json TEXT NOT NULL CHECK (json_valid(equipment_requirements_json)),
  difficulty INTEGER NOT NULL CHECK (difficulty BETWEEN 1 AND 5),
  complexity INTEGER NOT NULL CHECK (complexity BETWEEN 1 AND 5),
  fatigue_cost INTEGER NOT NULL CHECK (fatigue_cost BETWEEN 1 AND 5),
  spinal_loading TEXT NOT NULL CHECK (spinal_loading IN ('none', 'low', 'moderate', 'high')),
  impact TEXT NOT NULL CHECK (impact IN ('none', 'low', 'moderate', 'high')),
  unilateral INTEGER NOT NULL CHECK (unilateral IN (0, 1)),
  balance_demand TEXT NOT NULL CHECK (balance_demand IN ('low', 'medium', 'high')),
  mobility_demand TEXT NOT NULL CHECK (mobility_demand IN ('low', 'medium', 'high')),
  contraindication_flags_json TEXT NOT NULL CHECK (json_valid(contraindication_flags_json)),
  caution_flags_json TEXT NOT NULL CHECK (json_valid(caution_flags_json)),
  regression_ids_json TEXT NOT NULL CHECK (json_valid(regression_ids_json)),
  progression_ids_json TEXT NOT NULL CHECK (json_valid(progression_ids_json)),
  substitution_ids_json TEXT NOT NULL CHECK (json_valid(substitution_ids_json)),
  warmup_need_tags_json TEXT NOT NULL CHECK (json_valid(warmup_need_tags_json)),
  progression_family TEXT,
  progression_level INTEGER CHECK (progression_level IS NULL OR progression_level BETWEEN 1 AND 5),
  progression_prerequisites_json TEXT NOT NULL CHECK (json_valid(progression_prerequisites_json)),
  default_prescription_json TEXT CHECK (default_prescription_json IS NULL OR json_valid(default_prescription_json)),
  compatible_session_roles_json TEXT NOT NULL CHECK (json_valid(compatible_session_roles_json)),
  metadata_confidence_json TEXT NOT NULL CHECK (json_valid(metadata_confidence_json)),
  source TEXT NOT NULL CHECK (source IN ('repo_seed', 'coach_curated', 'admin_added', 'tenant_override', 'imported')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  global_canonical_id TEXT,
  tenant_override_scope TEXT NOT NULL DEFAULT '__global__',
  validation_status TEXT NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('pending', 'validated', 'invalid')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (catalog_version, scope_key, tenant_override_scope, exercise_id)
);

CREATE INDEX IF NOT EXISTS idx_training_exercise_catalog_items_selector
  ON training_exercise_catalog_items(
    catalog_version,
    scope_key,
    active,
    validation_status,
    modality,
    movement_pattern,
    exercise_id
  );

CREATE INDEX IF NOT EXISTS idx_training_exercise_catalog_items_global_canonical
  ON training_exercise_catalog_items(catalog_version, global_canonical_id)
  WHERE global_canonical_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_training_exercise_override_requires_global
BEFORE INSERT ON training_exercise_catalog_items
WHEN NEW.tenant_override_scope <> '__global__'
 AND (NEW.global_canonical_id IS NULL OR NEW.global_canonical_id = '')
BEGIN
  SELECT RAISE(ABORT, 'tenant exercise overrides must reference a global canonical ID');
END;

CREATE TRIGGER IF NOT EXISTS trg_training_exercise_catalog_items_active_immutable_update
BEFORE UPDATE ON training_exercise_catalog_items
WHEN EXISTS (
  SELECT 1
    FROM training_catalog_versions v
   WHERE v.catalog_version = OLD.catalog_version
     AND v.scope_key = OLD.scope_key
     AND v.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'active training catalog exercise rows are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_training_exercise_catalog_items_active_immutable_delete
BEFORE DELETE ON training_exercise_catalog_items
WHEN EXISTS (
  SELECT 1
    FROM training_catalog_versions v
   WHERE v.catalog_version = OLD.catalog_version
     AND v.scope_key = OLD.scope_key
     AND v.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'active training catalog exercise rows are immutable');
END;

CREATE TABLE IF NOT EXISTS training_catalog_validation_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  catalog_version TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT '__global__',
  validator TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed')),
  issues_json TEXT NOT NULL CHECK (json_valid(issues_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_training_catalog_validation_results_version
  ON training_catalog_validation_results(catalog_version, scope_key, created_at DESC);
