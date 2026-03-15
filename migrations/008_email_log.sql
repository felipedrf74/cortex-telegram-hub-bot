-- Email delivery log — tracks every automated email sent via sendEmail()
CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent',  -- 'sent' | 'failed'
  error_message TEXT,
  source TEXT,                           -- 'fossa_email' | 'manual' | job name
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_email_log_ts ON email_log (ts);
