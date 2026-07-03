-- 221: Reprice api_usage rows that were booked at the unresolved-pricing
-- sentinel ($3/$15 per Mtok) because OpenAI resolved the hardcoded fallback
-- alias 'gpt-4o-mini' to a dated snapshot name ('gpt-4o-mini-2024-07-18')
-- that the pricing registry could not match. The runtime fix lands in
-- src/services/model-pricing.ts (snapshot-suffix inheritance); this migration
-- heals history so per-user daily caps, Nexus Points overage settlement, and
-- portal COGS reports stop reading ~20x phantom cost.
--
-- Real gpt-4o-mini rates at time of writing (matches model-pricing.ts):
--   input $0.15/M, output $0.60/M, cache-read $0.075/M.
-- Scope is deliberately narrow: provider='openai', unresolved rows whose model
-- GLOBs a gpt-4o-mini date snapshot. Idempotent: repriced rows flip to
-- pricing_status='resolved' and no longer match the WHERE clause.

-- 1) Correct the per-user per-day metering aggregates by the delta between
--    the sentinel cost currently booked and the true snapshot cost.
UPDATE usage_metering
SET cost_usd = MAX(0, cost_usd - (
  SELECT SUM(
    a.cost_usd - (
      (MAX(0, a.input_tokens - COALESCE(a.cache_read_tokens, 0)) * 0.15
        + COALESCE(a.cache_read_tokens, 0) * 0.075
        + a.output_tokens * 0.60) / 1000000.0
    )
  )
  FROM api_usage a
  WHERE a.user_id = usage_metering.user_id
    AND date(a.ts) = usage_metering.date
    AND a.provider = 'openai'
    AND a.pricing_status = 'unresolved'
    AND a.model GLOB 'gpt-4o-mini-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
)),
    updated_at = datetime('now')
WHERE EXISTS (
  SELECT 1 FROM api_usage a
  WHERE a.user_id = usage_metering.user_id
    AND date(a.ts) = usage_metering.date
    AND a.provider = 'openai'
    AND a.pricing_status = 'unresolved'
    AND a.model GLOB 'gpt-4o-mini-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
);

-- 2) Reprice the api_usage rows themselves and mark them resolved against
--    the base registry key.
UPDATE api_usage
SET cost_usd = (
      (MAX(0, input_tokens - COALESCE(cache_read_tokens, 0)) * 0.15
        + COALESCE(cache_read_tokens, 0) * 0.075
        + output_tokens * 0.60) / 1000000.0
    ),
    pricing_status = 'resolved',
    pricing_model_key = 'gpt-4o-mini'
WHERE provider = 'openai'
  AND pricing_status = 'unresolved'
  AND model GLOB 'gpt-4o-mini-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]';
