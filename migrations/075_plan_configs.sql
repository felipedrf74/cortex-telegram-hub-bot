-- Migration 075: Portal-managed plan configuration.
--
-- Hardening 2026-04-21 — before this table existed, every per-plan
-- limit was hardcoded in `src/services/plan-quotas.ts`. Felipe could
-- not change Pro's $0.20 daily cap or Free's $0.005 cap from the
-- portal without a redeploy. The business requires:
--
--   • total daily cost cap per plan (admin-editable)
--   • total daily token cap per plan (admin-editable, optional)
--   • per-skill daily cost cap per plan (future-proofing)
--   • allowed skills per plan (stored as JSON array for flexibility)
--   • display name + metadata for portal rendering
--
-- This table is the admin's source of truth. `plan-quotas.ts` reads
-- hardcoded defaults at boot and then overrides them with any row
-- in this table via `loadPlanConfigOverridesFromDb()`. Runtime
-- edits update the table AND call `setPlanDailyCostCapOverride()` so
-- the change is immediately visible without a restart.

CREATE TABLE IF NOT EXISTS plan_configs (
  plan_id                TEXT PRIMARY KEY,            -- 'free' | 'pro' | 'max' | 'owner' | 'beta'
  display_name           TEXT NOT NULL,
  daily_cost_usd         REAL NOT NULL DEFAULT 0,
  daily_token_limit      INTEGER,                     -- null = unlimited
  daily_message_limit    INTEGER,
  allowed_skills_json    TEXT NOT NULL DEFAULT '[]',  -- JSON array of skill ids
  per_skill_caps_json    TEXT NOT NULL DEFAULT '{}',  -- JSON map { skillId: dailyCostUsd }
  metadata_json          TEXT NOT NULL DEFAULT '{}',
  active                 INTEGER NOT NULL DEFAULT 1,
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by             INTEGER                      -- admin user id (nullable — seed rows have no actor)
);

-- Seed current compiled-in defaults so the admin UI has something to
-- display on day one. The values match `plan-quotas.ts` defaults as
-- of the audit date. Future edits happen through the portal route.
INSERT OR IGNORE INTO plan_configs
  (plan_id, display_name, daily_cost_usd, daily_token_limit, daily_message_limit, allowed_skills_json, active)
VALUES
  ('free',  'Free',   0.005, 100000, 40,  '["secretary"]', 1),
  ('pro',   'Pro',    0.20,  500000, 200, '["secretary","training","content","cooking","finance"]', 1),
  ('max',   'Max',    0.60,  500000, 500, '["secretary","training","content","cooking","finance"]', 1),
  ('owner', 'Owner', 100.00, NULL,   NULL,'["secretary","training","content","cooking","finance"]', 1);

-- (Baseline seeds intentionally not audited here — the
--  `_migrations` row documents that migration 075 ran, and the
--  `plan_configs.updated_at` column records when rows changed.
--  Audit-trail writes begin with the first admin edit through the
--  portal route.)
