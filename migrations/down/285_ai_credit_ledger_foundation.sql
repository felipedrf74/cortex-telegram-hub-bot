-- Test/rehearsal inverse for migration 285.
-- Production rollback does not execute this contract operation: the credit
-- ledger is default OFF, so restoring the predecessor image against the
-- additive schema is sufficient. This inverse exists for isolated migration
-- verification only.

DROP TABLE IF EXISTS ai_credit_captures;
DROP TABLE IF EXISTS ai_credit_reservations;
DROP TABLE IF EXISTS ai_credit_lots;

ALTER TABLE plan_configs DROP COLUMN daily_ai_credit_cap;
ALTER TABLE plan_configs DROP COLUMN monthly_ai_credits;
