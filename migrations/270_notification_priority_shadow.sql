-- Notification priority shadow scoring (migration 270).
-- Shadow scoring for the notification priority model.
--
-- Records what the model WOULD have decided next to what the delivery ladder
-- actually did, so the two can be compared over real traffic before the model
-- is allowed to influence delivery. Nothing reads this to make a decision.
--
-- Kept out of notification_decision_logs deliberately: that table is the
-- delivery audit trail and is read by the reliability dashboard and the release
-- gate. Mixing a speculative score into it would make "what happened" and
-- "what a candidate model thinks should happen" indistinguishable.
--
-- Only populated when NOTIFICATION_PRIORITY_SHADOW_SCORING_ENABLED is on, so
-- it costs nothing until someone opts a cohort in.

CREATE TABLE IF NOT EXISTS notification_priority_shadow (
  shadow_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  source_skill TEXT NOT NULL,
  type TEXT NOT NULL,
  -- What the producer declared, and what the ladder actually did.
  declared_priority TEXT NOT NULL,
  effective_priority TEXT NOT NULL,
  actual_decision TEXT NOT NULL,
  -- What the model says.
  model_version INTEGER NOT NULL,
  score INTEGER NOT NULL,
  tier TEXT NOT NULL,
  reason_codes_json TEXT NOT NULL DEFAULT '[]',
  components_json TEXT NOT NULL DEFAULT '{}',
  -- False when the model ran on partial features (risk, reversibility and
  -- confidence are not yet plumbed from the quality gate). Recorded so the
  -- comparison is never read as more authoritative than it is.
  features_complete INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notification_priority_shadow_scope_created
  ON notification_priority_shadow(user_id, tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_priority_shadow_compare
  ON notification_priority_shadow(tier, actual_decision, created_at DESC);
