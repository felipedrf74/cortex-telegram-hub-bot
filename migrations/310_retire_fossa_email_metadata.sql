-- 310: retire owner-specific Fossa automation metadata without deleting history.
--
-- Delivery status and timestamps remain available for aggregate reliability
-- evidence. Recipient, subject, and error copy are no longer operationally
-- useful after retirement and may contain private account data.

-- Some predecessor release baselines carry the historical migration ledger
-- without a materialized email_log table. Reassert the canonical 008 shape so
-- this suffix remains additive and can redact any rows that do exist.
CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent',
  error_message TEXT,
  source TEXT,
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_email_log_ts ON email_log (ts);

UPDATE email_log
   SET recipient = '[redacted]',
       subject = 'Retired Secretary automation',
       error_message = NULL,
       source = 'retired_secretary_automation'
 WHERE lower(trim(COALESCE(source, ''))) = 'fossa_email';
