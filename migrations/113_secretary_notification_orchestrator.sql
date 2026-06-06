-- Secretary Notification Orchestrator
--
-- Central notification intent, decision, device-token, and delivery-attempt
-- storage. Skill code emits intents; the orchestrator decides delivery.

CREATE TABLE IF NOT EXISTS notification_profiles (
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  quiet_hours_start TEXT NOT NULL DEFAULT '22:00',
  quiet_hours_end TEXT NOT NULL DEFAULT '07:00',
  timezone TEXT NOT NULL DEFAULT 'Europe/Lisbon',
  push_enabled INTEGER NOT NULL DEFAULT 1,
  local_enabled INTEGER NOT NULL DEFAULT 1,
  email_enabled INTEGER NOT NULL DEFAULT 0,
  portal_enabled INTEGER NOT NULL DEFAULT 1,
  in_app_enabled INTEGER NOT NULL DEFAULT 1,
  secretary_enabled INTEGER NOT NULL DEFAULT 1,
  training_enabled INTEGER NOT NULL DEFAULT 1,
  content_enabled INTEGER NOT NULL DEFAULT 1,
  cooking_enabled INTEGER NOT NULL DEFAULT 1,
  finance_enabled INTEGER NOT NULL DEFAULT 1,
  chat_enabled INTEGER NOT NULL DEFAULT 1,
  system_enabled INTEGER NOT NULL DEFAULT 1,
  security_enabled INTEGER NOT NULL DEFAULT 1,
  default_reminder_minutes INTEGER NOT NULL DEFAULT 30,
  workout_reminder_minutes INTEGER NOT NULL DEFAULT 60,
  content_reminder_minutes INTEGER NOT NULL DEFAULT 120,
  finance_reminder_days INTEGER NOT NULL DEFAULT 1,
  allow_time_sensitive INTEGER NOT NULL DEFAULT 1,
  allow_critical INTEGER NOT NULL DEFAULT 0,
  digest_passive_items INTEGER NOT NULL DEFAULT 1,
  daily_digest_time TEXT NOT NULL DEFAULT '08:30',
  weekly_review_day INTEGER NOT NULL DEFAULT 1,
  weekly_review_time TEXT NOT NULL DEFAULT '09:00',
  do_not_notify_rules_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, tenant_id)
);

CREATE TABLE IF NOT EXISTS notification_intents (
  intent_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  source_skill TEXT NOT NULL,
  type TEXT NOT NULL,
  priority TEXT NOT NULL,
  related_entity_id TEXT,
  related_entity_type TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  sensitive_body TEXT,
  action_buttons_json TEXT NOT NULL DEFAULT '[]',
  deeplink TEXT,
  expires_at TEXT,
  quiet_hours_policy TEXT NOT NULL DEFAULT 'respect',
  dedupe_key TEXT,
  requires_user_action INTEGER NOT NULL DEFAULT 0,
  decision_deadline TEXT,
  delivery_policy TEXT NOT NULL DEFAULT 'auto',
  privacy_policy TEXT NOT NULL DEFAULT 'standard',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notification_intents_scope_created
  ON notification_intents(user_id, tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_intents_dedupe
  ON notification_intents(user_id, tenant_id, dedupe_key, status);

CREATE TABLE IF NOT EXISTS notification_center_items (
  item_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  decision_log_id TEXT,
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  safe_body TEXT NOT NULL,
  sensitive_body TEXT,
  source_skill TEXT NOT NULL,
  type TEXT NOT NULL,
  priority TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unread',
  deeplink TEXT,
  actions_json TEXT NOT NULL DEFAULT '[]',
  dedupe_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  read_at TEXT,
  dismissed_at TEXT,
  actioned_at TEXT,
  superseded_by_item_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_notification_center_scope_status_created
  ON notification_center_items(user_id, tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_center_dedupe
  ON notification_center_items(user_id, tenant_id, dedupe_key, status);

CREATE TABLE IF NOT EXISTS notification_decision_logs (
  decision_log_id TEXT PRIMARY KEY,
  notification_id TEXT,
  intent_id TEXT,
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  source_skill TEXT NOT NULL,
  source_entity_id TEXT,
  decision TEXT NOT NULL,
  priority TEXT NOT NULL,
  reason TEXT NOT NULL,
  dedupe_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  scheduled_for TEXT,
  sent_at TEXT,
  opened_at TEXT,
  action_taken TEXT,
  delivery_attempt_ids_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_notification_decision_logs_scope_created
  ON notification_decision_logs(user_id, tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_delivery_attempts (
  attempt_id TEXT PRIMARY KEY,
  notification_id TEXT,
  intent_id TEXT,
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  channel TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_response_code TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_notification_delivery_attempts_notification
  ON notification_delivery_attempts(notification_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_device_tokens (
  token_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  platform TEXT NOT NULL DEFAULT 'ios',
  token_hash TEXT NOT NULL,
  token_suffix TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'sandbox',
  device_id TEXT,
  app_version TEXT,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, tenant_id, platform, token_hash, environment)
);

CREATE INDEX IF NOT EXISTS idx_notification_device_tokens_scope_active
  ON notification_device_tokens(user_id, tenant_id, platform, revoked_at);
