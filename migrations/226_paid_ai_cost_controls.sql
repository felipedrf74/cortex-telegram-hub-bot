-- Migration 226: paid-only AI access, monthly budgets, and workload attribution.
--
-- api_usage remains the enforcement source of truth. usage_metering is retained
-- as an analytics aggregate only.

ALTER TABLE plan_configs ADD COLUMN monthly_cost_usd REAL NOT NULL DEFAULT 0
  CHECK (monthly_cost_usd >= 0);
ALTER TABLE user_ai_budget_overrides ADD COLUMN monthly_cost_usd REAL
  CHECK (monthly_cost_usd IS NULL OR monthly_cost_usd >= 0);

ALTER TABLE api_usage ADD COLUMN request_source TEXT NOT NULL DEFAULT 'interactive'
  CHECK (request_source IN ('interactive', 'automation', 'system'));
ALTER TABLE api_usage ADD COLUMN job_name TEXT;
ALTER TABLE api_usage ADD COLUMN base_category TEXT;
ALTER TABLE api_usage ADD COLUMN run_id TEXT;
-- Provider-hosted search is billed separately from tokens. Persist both the
-- observed unit count and its list-price component so cost_usd remains the
-- complete quota truth while operators can still reconcile the calculation.
ALTER TABLE api_usage ADD COLUMN provider_tool_cost_usd REAL NOT NULL DEFAULT 0
  CHECK (provider_tool_cost_usd >= 0);
ALTER TABLE api_usage ADD COLUMN web_search_requests INTEGER NOT NULL DEFAULT 0
  CHECK (web_search_requests >= 0);
ALTER TABLE api_usage ADD COLUMN grounded_search_prompts INTEGER NOT NULL DEFAULT 0
  CHECK (grounded_search_prompts >= 0);

CREATE TABLE IF NOT EXISTS ai_budget_deferrals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL DEFAULT 0,
  request_source  TEXT NOT NULL CHECK (request_source IN ('interactive', 'automation', 'system')),
  job_name        TEXT,
  base_category   TEXT NOT NULL,
  run_id          TEXT,
  code            TEXT NOT NULL,
  budget_window   TEXT,
  reset_at        TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_budget_deferrals_user_created
  ON ai_budget_deferrals(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_budget_deferrals_source_created
  ON ai_budget_deferrals(request_source, created_at);

-- Durable evidence that shared system-owned channel knowledge was actually
-- injected into a paid user's prompt. One marker per source/user/day is enough
-- for the 30-day platform-scope learning gate without inflating api_usage.
CREATE TABLE IF NOT EXISTS shared_knowledge_consumption (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  tenant_id    INTEGER NOT NULL,
  source       TEXT NOT NULL,
  consumed_on  TEXT NOT NULL DEFAULT (date('now')),
  consumed_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, tenant_id, source, consumed_on)
);
CREATE INDEX IF NOT EXISTS idx_shared_knowledge_consumption_scope_time
  ON shared_knowledge_consumption(user_id, tenant_id, consumed_at);

-- Free and historical beta/manual grants do not receive model-backed usage.
-- Secretary token-zero REST/read surfaces remain available independently of
-- these cost caps.
UPDATE plan_configs
SET daily_cost_usd = CASE plan_id
      WHEN 'free' THEN 0
      WHEN 'pro' THEN 0.04
      WHEN 'max' THEN 0.06
      WHEN 'owner' THEN 100.00
      ELSE daily_cost_usd
    END,
    monthly_cost_usd = CASE plan_id
      WHEN 'free' THEN 0
      WHEN 'pro' THEN 1.20
      WHEN 'max' THEN 1.80
      WHEN 'owner' THEN 3000.00
      ELSE monthly_cost_usd
    END,
    updated_at = datetime('now')
WHERE plan_id IN ('free', 'pro', 'max', 'owner');

-- Migration 075 normally guarantees these rows, but seed them explicitly so
-- a partially restored/hand-repaired database cannot boot without the exact
-- paid daily and monthly defaults this contract requires.
INSERT OR IGNORE INTO plan_configs (
  plan_id, display_name, daily_cost_usd, monthly_cost_usd,
  daily_token_limit, daily_message_limit, allowed_skills_json, active
)
VALUES
  ('free',  'Free',   0,     0,    NULL, NULL, '["secretary"]', 1),
  ('pro',   'Pro',    0.04,  1.20, NULL, NULL, '["secretary","triathlon","training","content","cooking","finance"]', 1),
  ('max',   'Max',    0.06,  1.80, NULL, NULL, '["secretary","triathlon","training","content","cooking","finance"]', 1),
  ('owner', 'Owner', 100.00, 3000, NULL, NULL, '["secretary","triathlon","training","content","cooking","finance"]', 1);

INSERT INTO plan_configs (
  plan_id, display_name, daily_cost_usd, monthly_cost_usd,
  daily_token_limit, daily_message_limit, allowed_skills_json, active
)
-- Beta/manual grants keep their legacy Max-style product surfaces. Their
-- model-backed allowance is still exactly zero and provider boundaries use the
-- canonical entitlement flags rather than this product allow-list.
VALUES ('beta', 'Beta', 0, 0, NULL, NULL, '["secretary","triathlon","training","content","cooking","finance"]', 1)
ON CONFLICT(plan_id) DO UPDATE SET
  daily_cost_usd = 0,
  monthly_cost_usd = 0,
  updated_at = datetime('now');

-- Legacy per-user columns are no longer quota authority, but zero the Free
-- default so an older read path cannot accidentally grant model access.
UPDATE users
SET daily_cost_limit_usd = 0
WHERE tier = 'free' OR tier IS NULL;

-- Conservative legacy attribution. Historical rows cannot reliably distinguish
-- every on-demand call from a scheduled call, so only known scheduled families
-- are promoted to automation; all user_id=0 traffic is system. Remaining
-- ambiguous user-scoped rows stay interactive rather than inventing provenance.
UPDATE api_usage
SET request_source = 'system',
    base_category = CASE
      WHEN lower(category) LIKE '%_gemini_model_fallback' THEN substr(category, 1, length(category) - 22)
      WHEN lower(category) LIKE '%_anthropic_fallback' THEN substr(category, 1, length(category) - 19)
      WHEN lower(category) LIKE '%_openai_fallback' THEN substr(category, 1, length(category) - 16)
      WHEN lower(category) LIKE '%_fallback' THEN substr(category, 1, length(category) - 9)
      ELSE category
    END
WHERE user_id = 0;

UPDATE api_usage
SET request_source = 'automation',
    base_category = CASE
      WHEN lower(category) LIKE '%_gemini_model_fallback' THEN substr(category, 1, length(category) - 22)
      WHEN lower(category) LIKE '%_anthropic_fallback' THEN substr(category, 1, length(category) - 19)
      WHEN lower(category) LIKE '%_openai_fallback' THEN substr(category, 1, length(category) - 16)
      WHEN lower(category) LIKE '%_fallback' THEN substr(category, 1, length(category) - 9)
      ELSE category
    END
WHERE user_id > 0
  AND (
    category LIKE 'coach_analysis%'
    OR category LIKE 'content_workflow_%'
    OR category LIKE 'channel_analysis%'
    OR category LIKE 'knowledge_synthesis%'
  );

UPDATE api_usage
SET base_category = CASE
      WHEN lower(category) LIKE '%_gemini_model_fallback' THEN substr(category, 1, length(category) - 22)
      WHEN lower(category) LIKE '%_anthropic_fallback' THEN substr(category, 1, length(category) - 19)
      WHEN lower(category) LIKE '%_openai_fallback' THEN substr(category, 1, length(category) - 16)
      WHEN lower(category) LIKE '%_fallback' THEN substr(category, 1, length(category) - 9)
      ELSE category
    END
WHERE base_category IS NULL;

CREATE INDEX IF NOT EXISTS idx_api_usage_user_source_ts
  ON api_usage(user_id, request_source, ts);
-- System/global budget queries filter by request_source without a user key,
-- so keep a source-led index in addition to the user-led entitlement index.
CREATE INDEX IF NOT EXISTS idx_api_usage_source_ts
  ON api_usage(request_source, ts);
-- Workload-wide rolling p95 groups by source + base category across users.
CREATE INDEX IF NOT EXISTS idx_api_usage_source_base_category_ts
  ON api_usage(request_source, base_category, ts);
CREATE INDEX IF NOT EXISTS idx_api_usage_user_base_category_ts
  ON api_usage(user_id, base_category, ts);
CREATE INDEX IF NOT EXISTS idx_api_usage_run_id
  ON api_usage(run_id)
  WHERE run_id IS NOT NULL;

-- Rollback: this append-only migration intentionally keeps attribution and
-- usage evidence if application code is rolled back. Disable
-- PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED first; older code ignores the new
-- columns/tables. To restore the pre-226 included-cap behavior after the code
-- rollback, run these repair statements explicitly on the backed-up database:
--   UPDATE plan_configs SET daily_cost_usd = 0.005 WHERE plan_id = 'free';
--   UPDATE plan_configs SET daily_cost_usd = 1.0 WHERE plan_id = 'beta';
--   UPDATE users SET daily_cost_limit_usd = 0.005 WHERE tier = 'free' OR tier IS NULL;
-- Do not drop api_usage attribution columns or shared_knowledge_consumption:
-- they are non-destructive evidence and remain forward-compatible.
