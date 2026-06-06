-- Decision Center per-type suppression preferences (C3 controls). A user can mute a (source_skill, type)
-- recipe permanently ('dont_show_type') or temporarily ('snooze_type' until a timestamp). The user-facing
-- Decision Center list + overview drop actively-suppressed types — EXCEPT policy-floored decisions, which are
-- never suppressible. Integrity/admin reads (release gate, dashboard breakdowns, summary counts) are NOT
-- filtered. One row per (user, tenant, source_skill, type) — re-suppressing replaces the prior mode. Runtime
-- self-heals the same table via ensureDecisionCenterTables().

CREATE TABLE IF NOT EXISTS decision_type_suppressions (
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  source_skill TEXT NOT NULL,
  type TEXT NOT NULL,
  mode TEXT NOT NULL,
  until TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, tenant_id, source_skill, type)
);

CREATE INDEX IF NOT EXISTS idx_decision_type_suppressions_scope
  ON decision_type_suppressions(user_id, tenant_id);
