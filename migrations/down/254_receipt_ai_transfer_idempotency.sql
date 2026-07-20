-- Roll back only the receipt AI idempotency cache/guard table introduced by
-- migration 254. The separate audit_trail consent records remain immutable as
-- legal/security evidence under the repository retention policy.

DROP INDEX IF EXISTS idx_receipt_ai_transfer_execution_status;
DROP TABLE IF EXISTS receipt_ai_transfer_executions;
