-- Finance tenant scope hardening.
--
-- Backfills tenant_id=user_id for legacy user-private Finance/Invoice rows.
-- Follow-up migration 146 rebuilds the finance tax uniqueness constraint to
-- include tenant_id after the Portugal/EUR money migrations have landed.

ALTER TABLE finance_transactions ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 0;
UPDATE finance_transactions SET tenant_id = user_id WHERE tenant_id = 0;
CREATE INDEX IF NOT EXISTS idx_finance_tx_tenant_user_date
  ON finance_transactions(tenant_id, user_id, date);

ALTER TABLE finance_tax_events ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 0;
UPDATE finance_tax_events SET tenant_id = user_id WHERE tenant_id = 0;
CREATE INDEX IF NOT EXISTS idx_finance_tax_tenant_user_month
  ON finance_tax_events(tenant_id, user_id, month);

ALTER TABLE invoice_filings ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 0;
UPDATE invoice_filings SET tenant_id = user_id WHERE tenant_id = 0;
CREATE INDEX IF NOT EXISTS idx_invoice_filings_tenant_user
  ON invoice_filings(tenant_id, user_id, document_date);

ALTER TABLE invoice_vendors ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 0;
UPDATE invoice_vendors SET tenant_id = user_id WHERE tenant_id = 0;
CREATE INDEX IF NOT EXISTS idx_invoice_vendors_tenant_user
  ON invoice_vendors(tenant_id, user_id);

ALTER TABLE fiscal_collection_profiles ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 0;
UPDATE fiscal_collection_profiles SET tenant_id = user_id WHERE tenant_id = 0;
CREATE INDEX IF NOT EXISTS idx_fiscal_collection_profiles_tenant_user
  ON fiscal_collection_profiles(tenant_id, user_id);
