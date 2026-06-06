-- Decision Center Logic v2: persist structured enrichment context emitted by skills.
--
-- SQLite does not support ALTER TABLE ... ADD COLUMN IF NOT EXISTS. Runtime
-- startup calls ensureNotificationTables(), which adds decision_context_json
-- with a PRAGMA table_info guard. Keeping this migration to an idempotent
-- marker mirrors migration 119 and prevents replay failures on local/staging
-- clones where runtime guards may already have added the column.

CREATE TABLE IF NOT EXISTS _migration_121_decision_intent_context_marker (
  run_at TEXT NOT NULL DEFAULT (datetime('now'))
);
