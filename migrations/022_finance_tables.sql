-- Finance Tracker tables: transactions + tax events
-- Used by the finance skill for expense tracking and DARF/Carnê-Leão calculation

CREATE TABLE IF NOT EXISTS finance_transactions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    date            TEXT NOT NULL,           -- ISO date YYYY-MM-DD
    category        TEXT NOT NULL,           -- e.g. 'income', 'expense', 'deduction'
    subcategory     TEXT,                    -- e.g. 'freelance', 'rent', 'software', 'health'
    amount          REAL NOT NULL,           -- positive for income, positive for expenses
    currency        TEXT NOT NULL DEFAULT 'BRL',
    description     TEXT,
    receipt_ref     TEXT,                    -- optional file reference or photo ID
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_finance_tx_user_date ON finance_transactions(user_id, date);
CREATE INDEX IF NOT EXISTS idx_finance_tx_category ON finance_transactions(user_id, category, date);

CREATE TABLE IF NOT EXISTS finance_tax_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    month           TEXT NOT NULL,           -- YYYY-MM format
    gross_income    REAL NOT NULL DEFAULT 0,
    deductions      REAL NOT NULL DEFAULT 0,
    taxable_income  REAL NOT NULL DEFAULT 0,
    tax_due         REAL NOT NULL DEFAULT 0,
    inss_due        REAL NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'pending',  -- pending, paid, overdue
    darf_code       TEXT,                   -- DARF payment code (e.g. 0190)
    paid_at         TEXT,
    notes           TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, month)
);

CREATE INDEX IF NOT EXISTS idx_finance_tax_user_month ON finance_tax_events(user_id, month);
