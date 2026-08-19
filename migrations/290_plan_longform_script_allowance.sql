-- 290: correct the daily long-form script allowance to the plan-locked values.
--
-- Plan §2 locks daily long-form scripts at Pro 2 / Max 4. Migration 284 seeded
-- Pro 6 / Max 20 — a 3x/5x over-grant on the most expensive operation class,
-- and the numbers the §4 economics simulation would otherwise have modelled
-- (QA5 P1-5). Free/beta stay 0 and owner keeps its operator allowance.
--
-- Backfill only: no schema change, no column drop, predecessor-compatible.

UPDATE plan_configs
SET longform_scripts_daily = CASE plan_id
      WHEN 'pro' THEN 2
      WHEN 'max' THEN 4
      ELSE longform_scripts_daily
    END
WHERE plan_id IN ('pro', 'max');
