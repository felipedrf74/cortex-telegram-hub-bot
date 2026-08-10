-- Notification correctness, Phase 0.
--
-- Additive only. Three concerns:
--
--  1. Snooze re-delivery. `snoozed_until` already exists but nothing ever
--     flipped a snoozed row back to unread, so snooze behaved as dismiss.
--     `snooze_count` bounds re-snoozing so an item cannot be deferred forever.
--
--  2. Surfaced-window suppression. `last_pushed_at` records when an item was
--     actually delivered to APNs, so a digest slot can tell "already
--     interrupted the user about this an hour ago" from "queued but silent".
--
--  3. Engagement instrumentation. `opened_at` and `action_taken` were already
--     written on the decision log but read nowhere, and neither carries the
--     surfaced/dismissed transitions needed to compute per-type fatigue. This
--     table is write-only for now: nothing scores off it until there is
--     enough history to tune against.

ALTER TABLE notification_center_items ADD COLUMN snooze_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notification_center_items ADD COLUMN last_pushed_at TEXT;

CREATE TABLE IF NOT EXISTS notification_engagement_events (
  event_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  notification_id TEXT,
  intent_id TEXT,
  source_skill TEXT NOT NULL,
  type TEXT NOT NULL,
  priority TEXT NOT NULL,
  -- surfaced | pushed | opened | actioned | dismissed | snoozed | expired_unseen
  event_type TEXT NOT NULL,
  action_id TEXT,
  -- Milliseconds between the item being surfaced and this event. NULL for the
  -- surfaced event itself and whenever the surfaced timestamp is unavailable.
  latency_ms INTEGER,
  -- Resolved runtime-flag/cohort vector at emit time. Deterministic cohorting
  -- already exists in runtime-flags; recording it here turns rollout gating
  -- into rollout measurement without new infrastructure.
  flag_vector_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notification_engagement_scope_type_created
  ON notification_engagement_events(user_id, tenant_id, source_skill, type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_engagement_event_type_created
  ON notification_engagement_events(event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_engagement_notification
  ON notification_engagement_events(notification_id, created_at DESC);

-- NOTE: the index supporting the snooze release sweep is created in
-- ensureNotificationTables(), not here. It covers `snoozed_until`, which is an
-- ensureColumn() self-heal rather than a migration column, so a database built
-- from migrations alone does not have it yet and CREATE INDEX would fail.
