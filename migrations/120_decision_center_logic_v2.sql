-- Decision Center Logic v2: outcome ledger and Handled by Nexus history.
-- Decision content remains in notification_intents / notification_center_items;
-- these tables store safe, scoped outcomes for trust, undo affordances, and
-- future offline evaluation without private raw payloads.

CREATE TABLE IF NOT EXISTS handled_by_nexus_items (
  handled_item_id TEXT PRIMARY KEY,
  decision_id TEXT,
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  source_skill TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  action_taken TEXT NOT NULL,
  why_brief TEXT NOT NULL,
  related_entities_json TEXT NOT NULL DEFAULT '[]',
  rollback_available INTEGER NOT NULL DEFAULT 0,
  changed_rule_option TEXT,
  privacy_classification TEXT NOT NULL DEFAULT 'standard',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_handled_by_nexus_scope_created
  ON handled_by_nexus_items(user_id, tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS decision_outcome_ledger (
  outcome_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  source_skill TEXT NOT NULL,
  type TEXT NOT NULL,
  priority_score INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0,
  automation_eligibility TEXT NOT NULL DEFAULT 'never',
  action_shown TEXT,
  action_taken TEXT,
  accepted INTEGER NOT NULL DEFAULT 0,
  dismissed INTEGER NOT NULL DEFAULT 0,
  snoozed INTEGER NOT NULL DEFAULT 0,
  ignored INTEGER NOT NULL DEFAULT 0,
  asked_nexus INTEGER NOT NULL DEFAULT 0,
  manually_corrected INTEGER NOT NULL DEFAULT 0,
  undo_used INTEGER NOT NULL DEFAULT 0,
  time_to_action_ms INTEGER,
  action_succeeded INTEGER NOT NULL DEFAULT 0,
  partial_failure INTEGER NOT NULL DEFAULT 0,
  failed_reason TEXT,
  feature_snapshot_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_decision_outcome_scope_created
  ON decision_outcome_ledger(user_id, tenant_id, created_at DESC);
