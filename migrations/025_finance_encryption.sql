-- Per-user data isolation + encryption for financial data
-- Adds encrypted columns alongside existing plaintext columns.
-- The service layer writes to both (encrypted + plain) and reads from encrypted when available.
-- Once all data is migrated, plaintext columns can be dropped in a future migration.

-- ── Encrypted columns for finance_transactions ──
ALTER TABLE finance_transactions ADD COLUMN encrypted_amount TEXT;
ALTER TABLE finance_transactions ADD COLUMN encrypted_description TEXT;

-- ── Encrypted columns for finance_tax_events ──
ALTER TABLE finance_tax_events ADD COLUMN encrypted_gross_income TEXT;
ALTER TABLE finance_tax_events ADD COLUMN encrypted_deductions TEXT;
ALTER TABLE finance_tax_events ADD COLUMN encrypted_taxable_income TEXT;
ALTER TABLE finance_tax_events ADD COLUMN encrypted_tax_due TEXT;
ALTER TABLE finance_tax_events ADD COLUMN encrypted_inss_due TEXT;
ALTER TABLE finance_tax_events ADD COLUMN encrypted_notes TEXT;

-- ── Per-user encryption metadata ──
CREATE TABLE IF NOT EXISTS user_encryption_meta (
    user_id         INTEGER PRIMARY KEY,
    key_version     INTEGER NOT NULL DEFAULT 1,
    encrypted_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
