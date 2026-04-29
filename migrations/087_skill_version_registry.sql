-- Migration 087: Skill version registry
--
-- This is separate from installed_skills. installed_skills answers
-- "is this skill/sub-skill enabled?", while this registry answers
-- "what release/version/capability truth is live, candidate, rolled back,
-- or tenant/user scoped?".

CREATE TABLE IF NOT EXISTS skill_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  version TEXT NOT NULL,
  release_type TEXT NOT NULL DEFAULT 'minor'
    CHECK (release_type IN ('major', 'minor', 'patch', 'hotfix', 'experimental')),
  release_title TEXT NOT NULL,
  release_summary TEXT NOT NULL,
  capabilities_added_json TEXT NOT NULL DEFAULT '[]',
  logic_improvements_json TEXT NOT NULL DEFAULT '[]',
  bug_fixes_json TEXT NOT NULL DEFAULT '[]',
  security_fixes_json TEXT NOT NULL DEFAULT '[]',
  tenant_scope_changes_json TEXT NOT NULL DEFAULT '[]',
  memory_context_changes_json TEXT NOT NULL DEFAULT '[]',
  model_routing_changes_json TEXT NOT NULL DEFAULT '[]',
  data_schema_changes_json TEXT NOT NULL DEFAULT '[]',
  ios_portal_contract_changes_json TEXT NOT NULL DEFAULT '[]',
  tests_added_json TEXT NOT NULL DEFAULT '[]',
  smoke_tests_passed_json TEXT NOT NULL DEFAULT '[]',
  evaluation_results_json TEXT NOT NULL DEFAULT '{}',
  open_risks_json TEXT NOT NULL DEFAULT '[]',
  known_limitations_json TEXT NOT NULL DEFAULT '[]',
  rollback_notes TEXT,
  internal_notes TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  activated_at TEXT,
  deprecated_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'candidate', 'active', 'deprecated', 'rolled_back')),
  rollout_scope TEXT NOT NULL DEFAULT 'global'
    CHECK (rollout_scope IN ('global', 'tenant', 'user', 'canary')),
  compatible_api_version TEXT,
  memory_schema_version TEXT,
  quality_gate_status TEXT,
  UNIQUE (skill_id, version)
);

CREATE INDEX IF NOT EXISTS idx_skill_versions_skill_status
  ON skill_versions (skill_id, status, activated_at);
CREATE INDEX IF NOT EXISTS idx_skill_versions_status
  ON skill_versions (status);

CREATE TABLE IF NOT EXISTS skill_version_rollouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_version_id INTEGER NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'global'
    CHECK (scope_type IN ('global', 'tenant', 'user', 'canary')),
  tenant_id INTEGER,
  user_id INTEGER,
  canary_key TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('candidate', 'active', 'deprecated', 'rolled_back')),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  activated_at TEXT,
  deprecated_at TEXT,
  rollback_target_version_id INTEGER,
  rollout_notes TEXT,
  FOREIGN KEY (skill_version_id) REFERENCES skill_versions(id) ON DELETE CASCADE,
  FOREIGN KEY (rollback_target_version_id) REFERENCES skill_versions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_skill_version_rollouts_scope
  ON skill_version_rollouts (scope_type, tenant_id, user_id, canary_key, status);
CREATE INDEX IF NOT EXISTS idx_skill_version_rollouts_version
  ON skill_version_rollouts (skill_version_id);

INSERT OR IGNORE INTO skill_versions (
  skill_id,
  skill_name,
  version,
  release_type,
  release_title,
  release_summary,
  capabilities_added_json,
  logic_improvements_json,
  tests_added_json,
  smoke_tests_passed_json,
  known_limitations_json,
  rollback_notes,
  created_by,
  activated_at,
  status,
  rollout_scope,
  compatible_api_version,
  memory_schema_version,
  quality_gate_status
) VALUES
  (
    'chat',
    'Chat',
    '1.0.0',
    'minor',
    'Baseline Chat runtime',
    'Baseline conversation, routing, and skill orchestration metadata record.',
    '["tenant-scoped conversation access","skill routing entry point","live model-routing compatible"]',
    '[]',
    '[]',
    '[]',
    '["Streaming and day-to-day simulation coverage should be checked in the latest Chat release docs."]',
    'Rollback to the prior deployed backend release and disable affected Chat flags if needed.',
    'migration_087',
    datetime('now'),
    'active',
    'global',
    'api-v1',
    'chat-memory-v1',
    'baseline'
  ),
  (
    'secretary',
    'Secretary',
    '2.0.0',
    'minor',
    'Baseline Secretary orchestration',
    'Baseline schedule, task, reminder, briefing, and calendar metadata record.',
    '["tasks","calendar","reminders","notes","briefings","shared-memory"]',
    '[]',
    '[]',
    '[]',
    '["Universal Secretary ownership should be checked in the latest Secretary release docs."]',
    'Rollback to the prior deployed backend release and disable new agenda lifecycle flags if needed.',
    'migration_087',
    datetime('now'),
    'active',
    'global',
    'api-v1',
    'secretary-memory-v1',
    'baseline'
  ),
  (
    'training',
    'Training',
    '3.0.0',
    'minor',
    'Baseline Training intelligence',
    'Baseline training plans, calendar sync, recovery, and athlete profile metadata record.',
    '["training plans","calendar sync","athlete profile","recovery signals"]',
    '[]',
    '[]',
    '[]',
    '["Provider staging and iOS rich-payload evidence should be checked in latest Training docs."]',
    'Rollback to the prior deployed backend release and restore pre-migration DB snapshot if schema rollback is required.',
    'migration_087',
    datetime('now'),
    'active',
    'global',
    'api-v1',
    'training-memory-v1',
    'baseline'
  ),
  (
    'finance',
    'Finance',
    '1.0.0',
    'minor',
    'Baseline Finance runtime',
    'Baseline expenses, tax, notes, and shared finance context metadata record.',
    '["expenses","tax","finance notes","shared-memory"]',
    '[]',
    '[]',
    '[]',
    '["Finance release hardening should add domain-specific evaluation evidence."]',
    'Rollback to the prior deployed backend release.',
    'migration_087',
    datetime('now'),
    'active',
    'global',
    'api-v1',
    'finance-memory-v1',
    'baseline'
  ),
  (
    'cooking',
    'Cooking',
    '1.0.0',
    'minor',
    'Baseline Cooking runtime',
    'Baseline recipes, meal planning, shopping, notes, and cooking context metadata record.',
    '["recipes","meal planning","shopping list","cooking notes","shared-memory"]',
    '[]',
    '[]',
    '[]',
    '["Cooking release hardening should add nutrition and cross-skill evaluation evidence."]',
    'Rollback to the prior deployed backend release.',
    'migration_087',
    datetime('now'),
    'active',
    'global',
    'api-v1',
    'cooking-memory-v1',
    'baseline'
  ),
  (
    'content',
    'Content Creation',
    '2.0.0',
    'minor',
    'Baseline Content Creation runtime',
    'Baseline content ideas, scripts, radar, references, and topic scheduling metadata record.',
    '["content ideas","script generation","radar preferences","books/channels references","topic scheduler"]',
    '[]',
    '[]',
    '[]',
    '["Full source provenance, lifecycle, and tenant-shared reference claims remain open in the Content workstream."]',
    'Rollback to the prior deployed backend release and disable new Content intelligence flags if needed.',
    'migration_087',
    datetime('now'),
    'active',
    'global',
    'api-v1',
    'content-memory-v1',
    'baseline'
  );

INSERT OR IGNORE INTO skill_version_rollouts (
  skill_version_id,
  scope_type,
  status,
  created_by,
  activated_at,
  rollout_notes
)
SELECT id, 'global', 'active', 'migration_087', COALESCE(activated_at, datetime('now')), 'Baseline global rollout'
FROM skill_versions
WHERE status = 'active';

