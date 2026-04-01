-- Error monitoring: persistent error log for tracking trends and alerting.
CREATE TABLE IF NOT EXISTS error_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL DEFAULT (datetime('now')),
  level       TEXT NOT NULL DEFAULT 'error',   -- 'error' | 'fatal' | 'warning'
  source      TEXT NOT NULL DEFAULT 'unknown',  -- 'bot' | 'job' | 'api' | 'unhandled' | 'portal' | 'process'
  message     TEXT NOT NULL,
  stack       TEXT,
  context     TEXT,                             -- JSON: extra metadata (domain, jobName, userId, etc.)
  alerted     INTEGER NOT NULL DEFAULT 0        -- 1 if Telegram alert was sent
);

CREATE INDEX IF NOT EXISTS idx_error_log_ts ON error_log (ts);
CREATE INDEX IF NOT EXISTS idx_error_log_source ON error_log (source);
CREATE INDEX IF NOT EXISTS idx_error_log_level ON error_log (level);
