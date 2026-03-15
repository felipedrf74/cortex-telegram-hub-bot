-- Job execution history — persists last N runs per job for sparkline charts
CREATE TABLE IF NOT EXISTS job_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_name TEXT NOT NULL,
  result TEXT NOT NULL,        -- 'success' | 'failed'
  duration_ms INTEGER,
  error_message TEXT,
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_job_history_name_ts ON job_history (job_name, ts);
