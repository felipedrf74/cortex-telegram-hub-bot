-- Portugal tax migration: keep legacy DARF column for one release, but store
-- the Portugal-facing invoice/reference code separately.

ALTER TABLE finance_tax_events ADD COLUMN pt_invoice_code TEXT;
ALTER TABLE finance_tax_events ADD COLUMN iva_due REAL NOT NULL DEFAULT 0;
ALTER TABLE finance_tax_events ADD COLUMN withholding_due REAL NOT NULL DEFAULT 0;
ALTER TABLE finance_tax_events ADD COLUMN ruleset TEXT;

UPDATE finance_tax_events
   SET pt_invoice_code = 'PT-IRS-ESTIMATE'
 WHERE pt_invoice_code IS NULL;

UPDATE finance_tax_events
   SET ruleset = 'pt-irs-2026-mainland-estimate'
 WHERE ruleset IS NULL;
