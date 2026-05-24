-- Chat Core v2 durable memory.
-- Memory rows are backend-owned, scoped by tenant/user, and statused so model
-- suggestions can stay pending until product policy accepts them.

CREATE TABLE IF NOT EXISTS chat_v2_memory_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'conversation_summary',
    'user_preference',
    'domain_preference',
    'decision_rationale',
    'recurring_pattern',
    'user_correction',
    'ignored_suggestion',
    'safety_constraint'
  )),
  domain TEXT CHECK (domain IN (
    'secretary',
    'tasks',
    'training',
    'content',
    'cooking',
    'finance',
    'connections',
    'notifications',
    'decision_center'
  )),
  value TEXT NOT NULL,
  source_turn_id TEXT,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'personal', 'financial', 'health_adjacent', 'credential_adjacent')),
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'deleted', 'needs_confirmation')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  UNIQUE(tenant_id, user_id, memory_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_v2_memory_items_scope
  ON chat_v2_memory_items(tenant_id, user_id, status, type, domain, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_v2_memory_items_source_turn
  ON chat_v2_memory_items(source_turn_id);
CREATE INDEX IF NOT EXISTS idx_chat_v2_memory_items_expiry
  ON chat_v2_memory_items(status, expires_at);
