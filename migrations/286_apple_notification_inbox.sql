-- 286: durable Apple App Store notification inbox (hybrid AI plan §3).
--
-- Replaces best-effort acknowledgement: a verified notification persists
-- before processing, so a processing failure is retried internally instead of
-- being lost behind an HTTP 200. Additive and default-inert: rows are written
-- only when the webhook receives traffic. Rows are append-only with guarded
-- state transitions; retention deletion is gated on the owner/legal retention
-- decision (NH-0035) and would arrive as its own migration.

CREATE TABLE apple_notification_inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_uuid TEXT NOT NULL,
  notification_type TEXT NOT NULL,
  subtype TEXT,
  environment TEXT,
  signed_payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE UNIQUE INDEX idx_apple_notification_inbox_uuid
  ON apple_notification_inbox (notification_uuid);
CREATE INDEX idx_apple_notification_inbox_state
  ON apple_notification_inbox (state, received_at);

CREATE TRIGGER apple_notification_inbox_no_delete
BEFORE DELETE ON apple_notification_inbox
BEGIN
  SELECT RAISE(ABORT, 'apple_notification_inbox rows are append-only');
END;

CREATE TRIGGER apple_notification_inbox_limited_update
BEFORE UPDATE ON apple_notification_inbox
WHEN NOT (
  NEW.id = OLD.id
  AND NEW.notification_uuid = OLD.notification_uuid
  AND NEW.notification_type = OLD.notification_type
  AND COALESCE(NEW.subtype, '') = COALESCE(OLD.subtype, '')
  AND COALESCE(NEW.environment, '') = COALESCE(OLD.environment, '')
  AND NEW.signed_payload = OLD.signed_payload
  AND NEW.received_at = OLD.received_at
  AND NEW.state IN ('pending', 'processed', 'failed')
  AND NEW.attempts >= OLD.attempts
)
BEGIN
  SELECT RAISE(ABORT, 'apple_notification_inbox permits only processing-state updates');
END;
