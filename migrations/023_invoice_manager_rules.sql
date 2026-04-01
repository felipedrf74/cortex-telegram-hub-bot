-- Invoice Manager: NLP rules and configurable collection schedules
-- Supports natural-language rule creation ("save attachments from meo.pt as MEO invoices")
-- and per-vendor/per-source configurable collection periodicity.

-- NLP-parsed filing rules created from natural language input
CREATE TABLE IF NOT EXISTS invoice_nlp_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,                          -- Rule display name (e.g., "MEO invoices")
    description TEXT,                            -- Original NL input from user
    vendor_pattern TEXT,                         -- Regex or substring for vendor matching
    sender_pattern TEXT,                         -- Email sender pattern (e.g., "meo.pt")
    subject_patterns TEXT,                       -- Comma-separated subject keywords
    amount_pattern TEXT,                         -- Regex for amount extraction
    action TEXT NOT NULL DEFAULT 'file',         -- 'file' | 'notify' | 'file_and_notify'
    folder_override TEXT,                        -- Custom filing folder (null = auto)
    confidence_threshold REAL DEFAULT 0.7,       -- Min NLP confidence to auto-apply
    enabled INTEGER DEFAULT 1,
    priority INTEGER DEFAULT 0,                  -- Higher = checked first
    match_count INTEGER DEFAULT 0,               -- Times this rule matched
    last_matched_at TEXT,                         -- Last successful match timestamp
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_nlp_rules_name ON invoice_nlp_rules(name);
CREATE INDEX IF NOT EXISTS idx_nlp_rules_enabled ON invoice_nlp_rules(enabled, priority DESC);
CREATE INDEX IF NOT EXISTS idx_nlp_rules_vendor ON invoice_nlp_rules(vendor_pattern);

-- Configurable collection schedules (replaces hardcoded cron per source)
CREATE TABLE IF NOT EXISTS invoice_collection_schedule (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collector_type TEXT NOT NULL,                 -- 'email' | 'amazon' | 'uber' | 'custom'
    vendor_name TEXT,                             -- Optional vendor filter
    cron_expression TEXT NOT NULL,                -- e.g., '0 9 1 * *'
    timezone TEXT DEFAULT 'Europe/Madrid',
    enabled INTEGER DEFAULT 1,
    last_run_at TEXT,
    next_run_at TEXT,
    last_result TEXT,                             -- 'success' | 'failed' | null
    last_error TEXT,
    run_count INTEGER DEFAULT 0,
    config_json TEXT,                             -- Provider-specific config (JSON)
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_collection_schedule_enabled ON invoice_collection_schedule(enabled);
CREATE INDEX IF NOT EXISTS idx_collection_schedule_type ON invoice_collection_schedule(collector_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_schedule_unique ON invoice_collection_schedule(collector_type, vendor_name);
