-- 313_runtime_logs.sql — queryable runtime log store for the operator portal.
--
-- Fed by src/utils/log-store.ts (a second pino stream), so every row has
-- already passed pino redaction. Bounded by the hourly prune in the same
-- module (72h / 500k rows). No PII beyond what pino already emits.
CREATE TABLE IF NOT EXISTS runtime_logs (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       TEXT NOT NULL,              -- ISO-8601 with milliseconds
  level    INTEGER NOT NULL,           -- pino numeric level (30=info, 40=warn, 50=error, 60=fatal)
  src      TEXT,                       -- request-context source (http | cron:<job> | ...)
  req_id   TEXT,                       -- x-request-id correlation key
  user_id  INTEGER,
  msg      TEXT NOT NULL,              -- <= 1000 chars, sanitized
  data     TEXT                        -- redacted JSON remainder, <= 4000 chars
);
CREATE INDEX IF NOT EXISTS idx_runtime_logs_ts ON runtime_logs (ts);
CREATE INDEX IF NOT EXISTS idx_runtime_logs_req ON runtime_logs (req_id);
CREATE INDEX IF NOT EXISTS idx_runtime_logs_level_ts ON runtime_logs (level, ts);
CREATE INDEX IF NOT EXISTS idx_runtime_logs_user_ts ON runtime_logs (user_id, ts);
-- Rollback: DROP TABLE IF EXISTS runtime_logs;
