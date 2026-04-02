-- Migration 024: Per-user data isolation
-- Adds owner_id column to all sensitive/financial tables for multi-user isolation.
-- Default value 'default' preserves backward compatibility with existing single-user data.
-- Encrypted fields (invoice amount, number, vendor) are handled at the application layer
-- via src/services/encryption.ts — no schema change needed for encryption itself.

-- ── invoice_filings ────────────────────────────────────────────────
ALTER TABLE invoice_filings ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_invoice_filings_owner ON invoice_filings(owner_id);

-- ── api_usage ──────────────────────────────────────────────────────
ALTER TABLE api_usage ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_api_usage_owner ON api_usage(owner_id);

-- ── email_log ──────────────────────────────────────────────────────
ALTER TABLE email_log ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_email_log_owner ON email_log(owner_id);

-- ── webhook_events ─────────────────────────────────────────────────
ALTER TABLE webhook_events ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_webhook_events_owner ON webhook_events(owner_id);

-- ── invoice_queue ──────────────────────────────────────────────────
ALTER TABLE invoice_queue ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_invoice_queue_owner ON invoice_queue(owner_id);
