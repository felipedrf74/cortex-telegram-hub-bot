-- Speed up duplicate checks: isDuplicate() queries by vendor + source_ref
CREATE INDEX IF NOT EXISTS idx_invoice_filings_vendor_ref
  ON invoice_filings (vendor, source_ref);

-- Speed up date-range queries used by monthly filing reports
CREATE INDEX IF NOT EXISTS idx_invoice_filings_document_date
  ON invoice_filings (document_date);
