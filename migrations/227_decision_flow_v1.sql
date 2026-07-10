-- Decision flow v1: additive lifecycle/concurrency metadata and privacy-safe
-- conflict audit records. Legacy notification status remains readable while
-- new clients opt into record-version enforcement.

ALTER TABLE notification_center_items ADD COLUMN decision_state TEXT;
ALTER TABLE notification_center_items ADD COLUMN record_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE notification_center_items ADD COLUMN updated_at TEXT;

UPDATE notification_center_items
   SET updated_at = COALESCE(updated_at, created_at),
       record_version = COALESCE(record_version, 1);

ALTER TABLE notification_intents ADD COLUMN context_version TEXT;
ALTER TABLE notification_intents ADD COLUMN context_observed_at TEXT;
ALTER TABLE notification_intents ADD COLUMN candidate_fingerprint TEXT;
ALTER TABLE notification_intents ADD COLUMN normalized_action_json TEXT;

ALTER TABLE decision_action_executions ADD COLUMN logical_action_hash TEXT;
ALTER TABLE decision_action_executions ADD COLUMN expected_record_version INTEGER;
ALTER TABLE decision_action_executions ADD COLUMN context_version TEXT;
ALTER TABLE decision_action_executions ADD COLUMN lease_expires_at TEXT;
ALTER TABLE decision_action_executions ADD COLUMN effect_results_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE decision_action_executions ADD COLUMN recovery_json TEXT NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS decision_conflict_evaluations (
  conflict_evaluation_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  policy_version TEXT NOT NULL,
  context_version TEXT NOT NULL,
  disposition TEXT NOT NULL,
  hard_conflict_count INTEGER NOT NULL DEFAULT 0,
  soft_conflict_count INTEGER NOT NULL DEFAULT 0,
  reason_codes_json TEXT NOT NULL DEFAULT '[]',
  related_decision_ids_json TEXT NOT NULL DEFAULT '[]',
  precedence_trace_json TEXT NOT NULL DEFAULT '[]',
  winner_decision_id TEXT,
  resolution TEXT,
  automatically_resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS decision_exclusivity_claims (
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  exclusivity_key TEXT NOT NULL,
  action_execution_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  context_version TEXT,
  status TEXT NOT NULL DEFAULT 'started',
  lease_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, tenant_id, exclusivity_key)
);

CREATE TABLE IF NOT EXISTS decision_flow_preferences (
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  allow_low_risk_auto_reflow INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_intents_candidate_fingerprint
  ON notification_intents(user_id, tenant_id, candidate_fingerprint, created_at DESC)
  WHERE candidate_fingerprint IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_decision_conflict_scope_created
  ON decision_conflict_evaluations(user_id, tenant_id, decision_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_decision_exclusivity_lease
  ON decision_exclusivity_claims(user_id, tenant_id, lease_expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_execution_active_logical_action
  ON decision_action_executions(user_id, tenant_id, logical_action_hash)
  WHERE logical_action_hash IS NOT NULL AND status IN ('started', 'succeeded', 'partially_failed');
