-- Migration 088: Version-aware skill memory foundation
--
-- shared_memory remains the compact Chat-era context store. This table is
-- the durable cross-skill memory ledger: typed, skill-scoped, tenant/user
-- scoped, confidence/freshness aware, correctable, and schema-versioned.

CREATE TABLE IF NOT EXISTS skill_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL UNIQUE,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL DEFAULT 0,
  skill_id TEXT NOT NULL,
  memory_type TEXT NOT NULL
    CHECK (memory_type IN (
      'user_preference',
      'tenant_preference',
      'skill_specific_memory',
      'cross_skill_signal',
      'action_history',
      'unresolved_commitment',
      'content_creative_preference',
      'schedule_preference',
      'training_preference',
      'cooking_preference',
      'finance_preference',
      'source_reference_preference',
      'voice_brand_preference',
      'correction_override',
      'stale_uncertain_memory'
    )),
  scope TEXT NOT NULL
    CHECK (scope IN ('user_private', 'tenant_shared', 'platform_internal')),
  memory_key TEXT NOT NULL,
  memory_value TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  freshness_status TEXT NOT NULL DEFAULT 'fresh'
    CHECK (freshness_status IN ('fresh', 'uncertain', 'stale', 'expired', 'corrected')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'superseded', 'stale', 'deleted')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  staleness_policy TEXT,
  schema_version TEXT NOT NULL DEFAULT 'skill-memory-v1',
  related_skill_version TEXT,
  superseded_by_memory_id TEXT,
  correction_parent_memory_id TEXT,
  correction_history_json TEXT NOT NULL DEFAULT '[]',
  audit_metadata_json TEXT NOT NULL DEFAULT '{}',
  last_used_at TEXT,
  use_count INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_memories_active_key
  ON skill_memories(tenant_id, user_id, skill_id, scope, memory_type, memory_key)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_skill_memories_tenant_user_skill
  ON skill_memories(tenant_id, user_id, skill_id, status, freshness_status);

CREATE INDEX IF NOT EXISTS idx_skill_memories_tenant_skill_scope
  ON skill_memories(tenant_id, skill_id, scope, status);

CREATE INDEX IF NOT EXISTS idx_skill_memories_expires
  ON skill_memories(expires_at, status)
  WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_skill_memories_schema
  ON skill_memories(skill_id, schema_version, status);

