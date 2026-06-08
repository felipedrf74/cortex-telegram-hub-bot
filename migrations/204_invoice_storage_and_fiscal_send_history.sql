-- Finance/fiscal durability and tenant-scope foundation.
-- Additive only: no live invoice/finance data is rebuilt or dropped here.

ALTER TABLE invoice_filings ADD COLUMN object_key TEXT;
ALTER TABLE invoice_filings ADD COLUMN checksum TEXT;
ALTER TABLE invoice_filings ADD COLUMN mime TEXT;
ALTER TABLE invoice_filings ADD COLUMN bytes INTEGER;
ALTER TABLE invoice_filings ADD COLUMN storage_backend TEXT;

UPDATE invoice_filings
   SET tenant_id = user_id
 WHERE tenant_id = 0
   AND user_id > 0;

UPDATE invoice_vendors
   SET tenant_id = user_id
 WHERE tenant_id = 0
   AND user_id > 0;

CREATE TABLE IF NOT EXISTS invoice_vendor_senders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  sender_pattern TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (vendor_id) REFERENCES invoice_vendors(id) ON DELETE CASCADE,
  UNIQUE(tenant_id, user_id, sender_pattern)
);

INSERT OR IGNORE INTO invoice_vendor_senders (
  vendor_id,
  tenant_id,
  user_id,
  sender_pattern,
  enabled
)
SELECT id,
       tenant_id,
       user_id,
       LOWER(TRIM(sender_pattern)),
       enabled
  FROM invoice_vendors
 WHERE sender_pattern IS NOT NULL
   AND TRIM(sender_pattern) <> ''
   AND user_id > 0
   AND tenant_id > 0;

CREATE INDEX IF NOT EXISTS idx_invoice_vendor_senders_tenant_user_vendor
  ON invoice_vendor_senders(tenant_id, user_id, vendor_id, enabled);

CREATE INDEX IF NOT EXISTS idx_invoice_vendor_senders_tenant_user_pattern
  ON invoice_vendor_senders(tenant_id, user_id, sender_pattern, enabled);

UPDATE fiscal_collection_profiles
   SET tenant_id = user_id
 WHERE tenant_id = 0
   AND user_id > 0;

ALTER TABLE invoice_queue ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 0;

UPDATE invoice_queue
   SET tenant_id = user_id
 WHERE tenant_id = 0
   AND user_id > 0;

UPDATE invoice_filings
   SET storage_backend = CASE
     WHEN object_key IS NOT NULL AND object_key <> '' THEN 'minio'
     WHEN remote_path IS NOT NULL AND remote_path <> '' THEN 'legacy_scp'
     ELSE storage_backend
   END
 WHERE storage_backend IS NULL;

UPDATE invoice_filings
   SET bytes = COALESCE(file_size_bytes, compressed_size_bytes)
 WHERE bytes IS NULL
   AND (file_size_bytes IS NOT NULL OR compressed_size_bytes IS NOT NULL);

UPDATE invoice_filings
   SET status = 'duplicate',
       error_message = COALESCE(error_message, 'Duplicate source_ref suppressed before unique fiscal storage index')
 WHERE id IN (
   SELECT id
     FROM (
       SELECT id,
              ROW_NUMBER() OVER (
                PARTITION BY tenant_id, user_id, source, source_ref
                ORDER BY id
              ) AS duplicate_rank
         FROM invoice_filings
        WHERE status = 'filed'
          AND source_ref IS NOT NULL
          AND source_ref <> ''
     )
    WHERE duplicate_rank > 1
 );

UPDATE invoice_filings
   SET status = 'duplicate',
       error_message = COALESCE(error_message, 'Duplicate vendor invoice number suppressed before unique fiscal storage index')
 WHERE id IN (
   SELECT id
     FROM (
       SELECT id,
              ROW_NUMBER() OVER (
                PARTITION BY tenant_id, user_id, vendor, invoice_number
                ORDER BY id
              ) AS duplicate_rank
         FROM invoice_filings
        WHERE status = 'filed'
          AND invoice_number IS NOT NULL
          AND invoice_number <> ''
     )
    WHERE duplicate_rank > 1
 );

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_filings_tenant_user_source_ref_filed
  ON invoice_filings(tenant_id, user_id, source, source_ref)
  WHERE source_ref IS NOT NULL AND source_ref <> '' AND status = 'filed';

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_filings_tenant_user_vendor_invoice_filed
  ON invoice_filings(tenant_id, user_id, vendor, invoice_number)
  WHERE invoice_number IS NOT NULL AND invoice_number <> '' AND status = 'filed';

CREATE INDEX IF NOT EXISTS idx_invoice_filings_tenant_user_period
  ON invoice_filings(tenant_id, user_id, document_date, status);

CREATE INDEX IF NOT EXISTS idx_invoice_queue_tenant_status
  ON invoice_queue(tenant_id, user_id, status, created_at);

CREATE TABLE IF NOT EXISTS fiscal_bundle_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  document_count INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, user_id, idempotency_key),
  UNIQUE(tenant_id, user_id, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_fiscal_bundle_sends_tenant_user_sent
  ON fiscal_bundle_sends(tenant_id, user_id, sent_at DESC);
