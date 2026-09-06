-- 317_product_analytics_events.sql
-- Locked Architecture RETUNE v1.1 product analytics events.
-- Vendor SDK deferred; this table is the durable internal sink.
-- Properties are enums/ids/versions only. Never PII.
-- api_usage remains cost/enforcement truth; do not overload it.

CREATE TABLE product_analytics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  event_name TEXT NOT NULL CHECK (event_name IN (
    'app_open',
    'onboarding_completed',
    'skill_first_success',
    'decision_center_acted',
    'paywall_viewed',
    'purchase_completed',
    'model_access_denied',
    'day7_retained'
  )),
  properties_json TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'server',
  idempotency_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, event_name, idempotency_key)
);

CREATE INDEX idx_product_analytics_user_event
  ON product_analytics_events(user_id, event_name, created_at);

CREATE INDEX idx_product_analytics_event_created
  ON product_analytics_events(event_name, created_at);
