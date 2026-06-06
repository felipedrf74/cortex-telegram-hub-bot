-- Chat Core v2 auto-revert decision audit log.
--
-- The auto-revert valve must be able to demote a tenant even if this insert
-- fails, but production/staging should still retain the safe decision trail.
-- Payload fields are JSON arrays/objects containing enums and numeric metrics
-- only; raw prompts, responses, titles, emails, calendar text, and other
-- private content do not belong in this table.

CREATE TABLE IF NOT EXISTS chat_v2_auto_revert_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  actions_json TEXT NOT NULL DEFAULT '[]',
  affected_languages_json TEXT NOT NULL DEFAULT '[]',
  reason_codes_json TEXT NOT NULL DEFAULT '[]',
  metrics_snapshot_json TEXT NOT NULL DEFAULT '{}',
  decided_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_v2_auto_revert_decisions_tenant_time
  ON chat_v2_auto_revert_decisions (tenant_id, decided_at);
