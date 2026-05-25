-- 159: CoachPlanPolicy persistence.
--
-- Per slice A5 of the Week-Level Adaptability + Periodization plan
-- (v2.1). Adds an optional JSON-encoded coach policy to each plan.
-- When NULL, the service layer applies defaults.
--
-- The policy is intentionally JSON (not a normalized side-table)
-- because:
--   - It evolves rapidly during Phase B development; column churn
--     would generate many small migrations.
--   - Reads are always whole-policy (no field-level queries).
--   - The schemaVersion field on the JSON drives backward-compat
--     for iOS reads — old plans with schemaVersion=1 stay
--     readable when the policy shape grows to schemaVersion=2.

ALTER TABLE fitness_training_plans
  ADD COLUMN coach_plan_policy_json TEXT;
