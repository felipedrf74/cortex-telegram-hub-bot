-- Durable operator alerts for issues that require human attention.
--
-- Portal telemetry and logs are useful for live visibility, but they are not a
-- durable work queue. This table stores deduped operational alerts so repeated
-- failures survive process restarts and can later be surfaced/acknowledged in
-- the portal without scraping logs.

CREATE TABLE IF NOT EXISTS operator_alerts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
  acknowledged_at  TEXT,
  acknowledged_by  TEXT,
  status           TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'acknowledged', 'resolved')),
  severity         TEXT NOT NULL
                   CHECK (severity IN ('info', 'warning', 'critical')),
  source           TEXT NOT NULL,
  dedupe_key       TEXT NOT NULL,
  title            TEXT NOT NULL,
  detail           TEXT,
  metadata_json    TEXT,
  occurrence_count INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_alerts_open_dedupe
  ON operator_alerts (dedupe_key)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_operator_alerts_status_created
  ON operator_alerts (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_operator_alerts_source_created
  ON operator_alerts (source, created_at DESC);
