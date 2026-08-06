-- 274: Privacy-safe deprecation-window usage telemetry for Training summary.
--
-- This is deliberately aggregate-only: one exact route-path counter per UTC
-- day. It stores no tenant, user, request, response, or provider data.

CREATE TABLE IF NOT EXISTS api_route_deprecation_metrics_daily (
  metric_date TEXT NOT NULL CHECK (length(metric_date) = 10),
  route_path TEXT NOT NULL CHECK (route_path = '/api/v1/training/summary'),
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (metric_date, route_path)
);
