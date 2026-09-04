-- 315_issues.sql — grouped error issues for the portal Issues panel.
--
-- One row per fingerprint (kind + source + normalised message + first stack
-- frame). Occurrences stay in error_log / client_errors and point back via
-- the additive issue_id column; req_id links an occurrence to the request
-- explorer.
CREATE TABLE IF NOT EXISTS issues (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint      TEXT NOT NULL UNIQUE,
  kind             TEXT NOT NULL CHECK (kind IN ('server', 'client')),
  source           TEXT NOT NULL,
  title            TEXT NOT NULL,            -- normalised message, <= 200 chars
  level            TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acked', 'resolved', 'muted')),
  first_seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  regressed_at     TEXT,
  resolved_at      TEXT,
  resolved_by      TEXT,
  notes            TEXT,
  sample_stack     TEXT,                     -- <= 8000 chars, sanitized
  last_req_id      TEXT,
  last_user_id     INTEGER,
  last_app_version TEXT,
  last_alert_id    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_issues_status_last ON issues (status, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_issues_kind_last ON issues (kind, last_seen_at);

ALTER TABLE error_log ADD COLUMN req_id TEXT;
ALTER TABLE error_log ADD COLUMN issue_id INTEGER;
ALTER TABLE client_errors ADD COLUMN req_id TEXT;
ALTER TABLE client_errors ADD COLUMN issue_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_error_log_issue ON error_log (issue_id, ts);
CREATE INDEX IF NOT EXISTS idx_error_log_req ON error_log (req_id);
CREATE INDEX IF NOT EXISTS idx_client_errors_issue ON client_errors (issue_id, ts);
CREATE INDEX IF NOT EXISTS idx_client_errors_req ON client_errors (req_id);
-- Rollback: DROP TABLE IF EXISTS issues; (ALTER TABLE columns are additive and stay)
