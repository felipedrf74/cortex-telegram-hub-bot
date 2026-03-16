-- Invoice queue: holds invoices when Mac SSH tunnel is unavailable
CREATE TABLE IF NOT EXISTS invoice_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'image',  -- 'image' | 'pdf'
  local_path TEXT NOT NULL,            -- path to file saved on server disk
  media_type TEXT,                     -- 'image/jpeg' | 'image/png' | 'image/webp' | null for PDF
  analysis_json TEXT NOT NULL,         -- JSON: InvoiceAnalysis or { vendor, documentDate, invoiceNumber, originalName }
  source TEXT NOT NULL DEFAULT 'photo', -- 'photo' | 'email' | 'amazon' | 'uber'
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'filed' | 'failed'
  retries INTEGER NOT NULL DEFAULT 0,
  last_retry_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  filed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_invoice_queue_status ON invoice_queue (status);
