-- Migration 022: Webhook event-driven integration layer
-- Replaces cron polling with webhook/event-driven architecture.
-- Three tables: subscriptions (contract), events (inbound log), delivery (processing log).

-- ── Webhook Subscriptions ───────────────────────────────────────────
-- Each row represents a registered webhook endpoint from an external provider.
-- provider: 'google_calendar' | 'google_gmail' | 'outlook_calendar' | 'outlook_mail'
--           | 'outlook_todo' | 'garmin' | 'strava' | 'github' | 'custom'

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  provider        TEXT    NOT NULL,
  event_types     TEXT    NOT NULL DEFAULT '["*"]',  -- JSON array of event types to accept
  endpoint_path   TEXT    NOT NULL,                   -- e.g. '/api/webhooks/google/calendar'
  secret          TEXT,                               -- HMAC secret for signature verification
  status          TEXT    NOT NULL DEFAULT 'active',  -- 'active' | 'paused' | 'expired' | 'revoked'
  external_id     TEXT,                               -- provider-side subscription ID (for renewal/cancel)
  metadata        TEXT,                               -- JSON: provider-specific config (channel_id, resource_uri, etc.)
  expires_at      TEXT,                               -- ISO 8601; NULL = no expiry
  last_event_at   TEXT,                               -- ISO 8601; updated on each received event
  event_count     INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_webhook_subs_provider ON webhook_subscriptions (provider);
CREATE INDEX IF NOT EXISTS idx_webhook_subs_status   ON webhook_subscriptions (status);

-- ── Webhook Events (inbound log) ────────────────────────────────────
-- Every incoming webhook payload is logged here before processing.
-- Enables replay, debugging, and audit trail.

CREATE TABLE IF NOT EXISTS webhook_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER,
  provider        TEXT    NOT NULL,
  event_type      TEXT    NOT NULL,                   -- provider-specific: 'calendar.updated', 'activity.created', etc.
  payload         TEXT    NOT NULL,                    -- raw JSON body
  headers         TEXT,                               -- JSON of relevant headers (signature, etc.)
  status          TEXT    NOT NULL DEFAULT 'received', -- 'received' | 'processing' | 'processed' | 'failed' | 'ignored'
  error_message   TEXT,
  idempotency_key TEXT,                               -- provider message ID for dedup
  received_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  processed_at    TEXT,
  FOREIGN KEY (subscription_id) REFERENCES webhook_subscriptions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_provider   ON webhook_events (provider);
CREATE INDEX IF NOT EXISTS idx_webhook_events_status     ON webhook_events (status);
CREATE INDEX IF NOT EXISTS idx_webhook_events_received   ON webhook_events (received_at);
CREATE INDEX IF NOT EXISTS idx_webhook_events_idemp      ON webhook_events (idempotency_key);

-- ── Webhook Delivery Log (processing log) ───────────────────────────
-- Tracks each attempt to dispatch a webhook event to an internal handler.
-- Supports retry logic and failure diagnosis.

CREATE TABLE IF NOT EXISTS webhook_delivery_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        INTEGER NOT NULL,
  handler         TEXT    NOT NULL,                   -- internal handler name: 'calendar_sync', 'activity_import', etc.
  status          TEXT    NOT NULL DEFAULT 'pending', -- 'pending' | 'success' | 'failed' | 'skipped'
  attempt         INTEGER NOT NULL DEFAULT 1,
  duration_ms     INTEGER,
  error_message   TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (event_id) REFERENCES webhook_events(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_webhook_delivery_event  ON webhook_delivery_log (event_id);
CREATE INDEX IF NOT EXISTS idx_webhook_delivery_status ON webhook_delivery_log (status);

-- ── Cleanup: auto-expire old events (keep 30 days) ─────────────────
-- This trigger removes webhook events older than 30 days on each insert
-- to prevent unbounded table growth (same pattern as conversation pruning).

CREATE TRIGGER IF NOT EXISTS trg_webhook_events_cleanup
AFTER INSERT ON webhook_events
BEGIN
  DELETE FROM webhook_events
  WHERE received_at < datetime('now', '-30 days')
    AND status IN ('processed', 'ignored');
END;
