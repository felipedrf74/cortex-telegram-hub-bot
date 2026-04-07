-- 041_client_errors.sql
-- Audit P0-9: client-side error reporting from iOS app + future web clients.
--
-- The iOS app currently has zero observability — errors live in print
-- statements. This table is the backend ingestion point for crash reports,
-- network errors, and unexpected exceptions. The iOS ClientErrorReporter
-- POSTs to /api/v1/client-errors which inserts here. The portal can later
-- query trends.
--
-- Schema notes:
--   - user_id is the JWT-extracted owner. Required (no anonymous reports).
--   - device_id is iOS identifierForVendor (or future browser fingerprint)
--     so we can distinguish "user has 1 device with a recurring bug" from
--     "user has 5 devices each hitting it once".
--   - source is a free-form string like 'ios', 'ios-watch', 'web' so we
--     can filter by client without table-scanning the user_agent.
--   - level matches the existing error_log conventions: error / fatal / warn.
--   - message is required, max ~2000 chars enforced at write time.
--   - context is an optional JSON blob for arbitrary metadata (route name,
--     user action, request ID, response body if relevant). Stored as TEXT
--     because SQLite has no native JSON type and we don't query it.
--   - app_version + os_version are optional but useful for triage when
--     the same error only happens on iOS 18.x or app v1.2.0.

CREATE TABLE IF NOT EXISTS client_errors (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT NOT NULL DEFAULT (datetime('now')),
  user_id         INTEGER NOT NULL,
  device_id       TEXT,
  source          TEXT NOT NULL DEFAULT 'ios',
  level           TEXT NOT NULL DEFAULT 'error',
  message         TEXT NOT NULL,
  stack           TEXT,
  context         TEXT,            -- JSON blob, opaque
  app_version     TEXT,
  os_version      TEXT,
  user_agent      TEXT
);

-- Time-range queries for the portal dashboard ("errors in last 24h")
CREATE INDEX IF NOT EXISTS idx_client_errors_ts ON client_errors(ts);

-- Per-user filter for "show me my own crashes" (GDPR self-service)
CREATE INDEX IF NOT EXISTS idx_client_errors_user ON client_errors(user_id, ts DESC);

-- Per-source breakdown for "are iOS or web clients more crashy?"
CREATE INDEX IF NOT EXISTS idx_client_errors_source ON client_errors(source, ts DESC);
