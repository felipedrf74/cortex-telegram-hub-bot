-- Finance Portugal/EUR table rebuild.
--
-- Migration 022 created BRL defaults and a user-only tax uniqueness key. The
-- runtime now writes explicit integer cents, tenant_id, and Portugal tax
-- estimates. Rebuild the two core tables so new direct DB inserts default to
-- EUR and monthly tax rows are unique per (tenant, user, month).

PRAGMA foreign_keys=OFF;

CREATE TABLE finance_transactions__eur_tenant (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id               INTEGER NOT NULL,
    tenant_id             INTEGER NOT NULL,
    date                  TEXT NOT NULL,
    category              TEXT NOT NULL,
    subcategory           TEXT,
    amount                REAL NOT NULL,
    amount_cents          INTEGER,
    currency              TEXT NOT NULL DEFAULT 'EUR',
    description           TEXT,
    receipt_ref           TEXT,
    encrypted_amount      TEXT,
    encrypted_description TEXT,
    deleted_at            TEXT,
    delete_reason         TEXT,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO finance_transactions__eur_tenant (
    id, user_id, tenant_id, date, category, subcategory, amount, amount_cents,
    currency, description, receipt_ref, encrypted_amount, encrypted_description,
    deleted_at, delete_reason, created_at, updated_at
)
SELECT
    id,
    user_id,
    COALESCE(NULLIF(tenant_id, 0), user_id),
    date,
    category,
    subcategory,
    amount,
    amount_cents,
    COALESCE(NULLIF(currency, ''), 'EUR'),
    description,
    receipt_ref,
    encrypted_amount,
    encrypted_description,
    deleted_at,
    delete_reason,
    created_at,
    updated_at
FROM finance_transactions;

DROP TABLE finance_transactions;
ALTER TABLE finance_transactions__eur_tenant RENAME TO finance_transactions;

CREATE INDEX IF NOT EXISTS idx_finance_tx_user_date ON finance_transactions(user_id, date);
CREATE INDEX IF NOT EXISTS idx_finance_tx_category ON finance_transactions(user_id, category, date);
CREATE INDEX IF NOT EXISTS idx_finance_tx_user_deleted ON finance_transactions(user_id, deleted_at, date);
CREATE INDEX IF NOT EXISTS idx_finance_tx_user_date_amount_cents
  ON finance_transactions(user_id, date, amount_cents);
CREATE INDEX IF NOT EXISTS idx_finance_tx_tenant_user_date
  ON finance_transactions(tenant_id, user_id, date);

CREATE TABLE finance_tax_events__tenant_unique (
    id                         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id                    INTEGER NOT NULL,
    tenant_id                  INTEGER NOT NULL,
    month                      TEXT NOT NULL,
    gross_income               REAL NOT NULL DEFAULT 0,
    deductions                 REAL NOT NULL DEFAULT 0,
    taxable_income             REAL NOT NULL DEFAULT 0,
    tax_due                    REAL NOT NULL DEFAULT 0,
    inss_due                   REAL NOT NULL DEFAULT 0,
    status                     TEXT NOT NULL DEFAULT 'pending',
    darf_code                  TEXT,
    pt_invoice_code            TEXT,
    iva_due                    REAL NOT NULL DEFAULT 0,
    withholding_due            REAL NOT NULL DEFAULT 0,
    ruleset                    TEXT,
    paid_at                    TEXT,
    notes                      TEXT,
    encrypted_gross_income     TEXT,
    encrypted_deductions       TEXT,
    encrypted_taxable_income   TEXT,
    encrypted_tax_due          TEXT,
    encrypted_inss_due         TEXT,
    encrypted_notes            TEXT,
    created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                 TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, user_id, month)
);

INSERT INTO finance_tax_events__tenant_unique (
    id, user_id, tenant_id, month, gross_income, deductions, taxable_income,
    tax_due, inss_due, status, darf_code, pt_invoice_code, iva_due, withholding_due, ruleset, paid_at, notes,
    encrypted_gross_income, encrypted_deductions, encrypted_taxable_income,
    encrypted_tax_due, encrypted_inss_due, encrypted_notes, created_at, updated_at
)
SELECT
    id,
    user_id,
    COALESCE(NULLIF(tenant_id, 0), user_id),
    month,
    gross_income,
    deductions,
    taxable_income,
    tax_due,
    inss_due,
    status,
    darf_code,
    pt_invoice_code,
    COALESCE(iva_due, 0),
    COALESCE(withholding_due, 0),
    COALESCE(ruleset, 'pt-irs-2026-mainland-estimate'),
    paid_at,
    notes,
    encrypted_gross_income,
    encrypted_deductions,
    encrypted_taxable_income,
    encrypted_tax_due,
    encrypted_inss_due,
    encrypted_notes,
    created_at,
    updated_at
FROM finance_tax_events;

DROP TABLE finance_tax_events;
ALTER TABLE finance_tax_events__tenant_unique RENAME TO finance_tax_events;

CREATE INDEX IF NOT EXISTS idx_finance_tax_user_month ON finance_tax_events(user_id, month);
CREATE INDEX IF NOT EXISTS idx_finance_tax_tenant_user_month
  ON finance_tax_events(tenant_id, user_id, month);

PRAGMA foreign_keys=ON;
