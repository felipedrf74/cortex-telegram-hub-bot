-- 314_http_request_log.sql — sampled HTTP request ledger for the portal
-- Requests explorer (lookup by x-request-id, latency percentiles per route).
--
-- Fed by src/api/http-request-log.ts from the portal server finish hook.
-- IPs are stored as salted hashes. Bounded by the hourly prune (7d / 500k).
CREATE TABLE IF NOT EXISTS http_request_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,
  req_id       TEXT NOT NULL,
  surface      TEXT NOT NULL,          -- ios | portal | webhook | health | oauth | public | static
  method       TEXT NOT NULL,
  path         TEXT NOT NULL,          -- raw path, no query string
  route        TEXT NOT NULL,          -- normalised (ids -> :id) for aggregation
  status       INTEGER NOT NULL,
  duration_ms  INTEGER NOT NULL,
  user_id      INTEGER,
  ip_hash      TEXT,
  user_agent   TEXT,                   -- <= 200 chars
  bytes_out    INTEGER,
  sampled      INTEGER NOT NULL DEFAULT 0  -- 1 when stored via the sampling rule
);
CREATE INDEX IF NOT EXISTS idx_http_request_log_req ON http_request_log (req_id);
CREATE INDEX IF NOT EXISTS idx_http_request_log_ts ON http_request_log (ts);
CREATE INDEX IF NOT EXISTS idx_http_request_log_user_ts ON http_request_log (user_id, ts);
CREATE INDEX IF NOT EXISTS idx_http_request_log_status_ts ON http_request_log (status, ts);
CREATE INDEX IF NOT EXISTS idx_http_request_log_route_ts ON http_request_log (route, ts);
-- Rollback: DROP TABLE IF EXISTS http_request_log;
