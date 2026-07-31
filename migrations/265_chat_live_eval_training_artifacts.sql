-- 265: Exact ownership ledger for the dedicated chat live-eval Training fixture.
--
-- The ledger stores only scope, scenario, plan identity, and seed-contract
-- provenance. It never stores prompts, session descriptions, model responses,
-- provider payloads, or real-user Training data.

CREATE TABLE IF NOT EXISTS chat_live_eval_training_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  scenario_id TEXT NOT NULL CHECK (scenario_id = 'training_adjustment'),
  plan_id INTEGER NOT NULL UNIQUE,
  seed_profile_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (user_id, tenant_id),
  FOREIGN KEY (plan_id) REFERENCES fitness_training_plans(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_live_eval_training_artifacts_scope
  ON chat_live_eval_training_artifacts(tenant_id, user_id);
