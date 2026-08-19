-- Down for 291: drop the reconciliation cursor table and index.

DROP INDEX IF EXISTS idx_ai_credit_lot_reconciliation_checked;
DROP TABLE IF EXISTS ai_credit_lot_reconciliation_state;
