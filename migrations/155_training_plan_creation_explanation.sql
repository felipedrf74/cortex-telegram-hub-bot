-- 155: Training plan creation explanation
--
-- Stores the structured trust-wedge explanation generated at plan creation.
-- The JSON is additive: older clients ignore it, newer clients can show why
-- Nexus chose inferred defaults, respected explicit inputs, and surfaced
-- confidence gaps.

ALTER TABLE fitness_training_plans
  ADD COLUMN explanation_json TEXT;

ALTER TABLE fitness_training_plans
  ADD COLUMN explanation_schema_version INTEGER;

CREATE INDEX IF NOT EXISTS idx_training_plans_explanation_schema
  ON fitness_training_plans(explanation_schema_version);
