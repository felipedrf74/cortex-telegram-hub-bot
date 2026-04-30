-- Preserve Chat shared-memory correction lineage.
-- The active shared_memory row remains the fast read model; this table keeps
-- superseded values for audit, support, privacy review, and rollback analysis.

CREATE TABLE IF NOT EXISTS shared_memory_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  previous_value TEXT NOT NULL,
  new_value TEXT NOT NULL,
  previous_source_domain TEXT,
  new_source_domain TEXT NOT NULL,
  previous_expires_at TEXT,
  new_expires_at TEXT,
  previous_visibility_scope TEXT,
  new_visibility_scope TEXT NOT NULL,
  previous_scope_status TEXT,
  new_scope_status TEXT NOT NULL,
  corrected_by INTEGER,
  corrected_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_shared_memory_history_scope
  ON shared_memory_history(tenant_id, user_id, key, corrected_at);
