-- Migration 043: integration_health table for synthetic health probes
--
-- Audit Weeks 2-4 finding: when Garmin/Notion/Google/Anthropic/Gemini go
-- down or have credential expiry, the operator currently finds out via a
-- user complaint or by reading PM2 stderr — there's no proactive signal.
--
-- This table stores the result of periodic synthetic probes that hit each
-- integration's cheapest authenticated endpoint and record success/failure.
-- The probe runs in src/services/integration-health.ts on a 5-minute cron.
--
-- Schema notes:
--   * One row per probe attempt — full history, not just current state.
--     This lets the portal show "Garmin: 47/50 successful probes in last
--     4 hours" with trend visibility, not just a binary up/down indicator.
--   * `provider` is the integration name (matches OAuthProvider enum
--     where applicable: 'google', 'outlook', 'garmin', 'notion', 'anthropic',
--     'gemini', 'openai').
--   * `status` is 'ok' | 'fail' | 'skipped'. 'skipped' is for integrations
--     that aren't configured (no credentials) so we don't penalize them.
--   * `error_message` captures the failure reason for fail/skipped rows
--     (truncated to 500 chars). NULL for ok rows to save space.
--   * `latency_ms` measures how long the probe took. Useful for spotting
--     degradation BEFORE outright failure (Garmin gets slow before it 5xxs).
--   * Retention: this table is included in the midnight_cleanup retention
--     policy (60 days, same as error_log).

CREATE TABLE IF NOT EXISTS integration_health (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT NOT NULL DEFAULT (datetime('now')),
  provider        TEXT NOT NULL,
  status          TEXT NOT NULL,           -- 'ok' | 'fail' | 'skipped'
  latency_ms      INTEGER,
  error_message   TEXT
);

-- Time-range queries for the portal: "Garmin status in last 4h"
CREATE INDEX IF NOT EXISTS idx_integration_health_provider_ts
  ON integration_health (provider, ts DESC);

-- Status filter for "all current failures across all providers"
CREATE INDEX IF NOT EXISTS idx_integration_health_status
  ON integration_health (status, ts DESC);
