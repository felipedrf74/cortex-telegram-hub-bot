-- Invoice filing log (tracks all filed invoices regardless of source)
CREATE TABLE IF NOT EXISTS invoice_filings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor TEXT NOT NULL,
    amount TEXT,
    document_date TEXT,
    invoice_number TEXT,
    source TEXT NOT NULL,              -- 'photo' | 'email' | 'amazon' | 'uber'
    source_ref TEXT,                   -- email message ID or 'telegram_photo'
    remote_path TEXT,
    folder_path TEXT,
    filename TEXT,
    file_size_bytes INTEGER,
    compressed_size_bytes INTEGER,
    status TEXT DEFAULT 'filed',       -- 'filed' | 'failed' | 'duplicate'
    error_message TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_invoice_dup ON invoice_filings(vendor, invoice_number);
CREATE INDEX IF NOT EXISTS idx_invoice_date ON invoice_filings(document_date);

-- User-added invoice vendors (dynamic vendor learning)
CREATE TABLE IF NOT EXISTS invoice_vendors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,                -- Display name (e.g., "MEO")
    sender_pattern TEXT NOT NULL,      -- Email sender domain/address (e.g., "meo.pt")
    subject_patterns TEXT,             -- Comma-separated subject keywords (e.g., "fatura,recibo")
    enabled INTEGER DEFAULT 1,        -- 1 = active, 0 = disabled
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vendor_sender ON invoice_vendors(sender_pattern);
