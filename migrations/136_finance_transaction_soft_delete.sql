-- 136: Finance transaction soft delete
--
-- Finance transactions are financial audit records. User-facing delete
-- actions should hide rows from operational reads while preserving an
-- auditable tombstone for reconciliation, exports, and future audit-trail
-- joins. Full GDPR erasure still uses the explicit user-data deletion path.

ALTER TABLE finance_transactions ADD COLUMN deleted_at TEXT;
ALTER TABLE finance_transactions ADD COLUMN delete_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_finance_tx_user_active_date
  ON finance_transactions(user_id, deleted_at, date);
