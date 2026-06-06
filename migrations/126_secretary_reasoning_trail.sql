-- Migration 126: Secretary reasoning trail support + source-skill feedback consumers
--
-- The reasoning trail column itself is still added idempotently by the
-- Secretary arbitrator because legacy/local test databases may be initialized
-- from migration 083 only. This migration adds the durable Training feedback
-- sink consumed by the W-B SecretaryFeedbackBus Training consumer and the
-- shared Wave 2 sink for Cooking / Finance / Content feedback.

CREATE TABLE IF NOT EXISTS training_feedback_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  source_skill TEXT NOT NULL DEFAULT 'secretary',
  agenda_item_id TEXT NOT NULL,
  source_intent_id TEXT NOT NULL,
  feedback_type TEXT NOT NULL,
  status TEXT NOT NULL,
  reason_codes_json TEXT NOT NULL DEFAULT '[]',
  scheduled_start TEXT,
  scheduled_end TEXT,
  should_refresh_source INTEGER NOT NULL DEFAULT 0,
  downstream_implications_json TEXT NOT NULL DEFAULT '[]',
  hints_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, tenant_id, agenda_item_id, source_intent_id)
);

CREATE INDEX IF NOT EXISTS idx_training_feedback_decisions_scope
  ON training_feedback_decisions(user_id, tenant_id, created_at);

CREATE TABLE IF NOT EXISTS secretary_source_skill_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  target_skill TEXT NOT NULL,
  agenda_item_id TEXT NOT NULL,
  source_intent_id TEXT NOT NULL,
  feedback_type TEXT NOT NULL,
  status TEXT NOT NULL,
  reason_codes_json TEXT NOT NULL DEFAULT '[]',
  scheduled_start TEXT,
  scheduled_end TEXT,
  should_refresh_source INTEGER NOT NULL DEFAULT 0,
  downstream_implications_json TEXT NOT NULL DEFAULT '[]',
  hints_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, tenant_id, target_skill, agenda_item_id, source_intent_id)
);

CREATE INDEX IF NOT EXISTS idx_secretary_source_skill_feedback_scope
  ON secretary_source_skill_feedback(user_id, tenant_id, target_skill, created_at);
