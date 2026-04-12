-- Migration 061: Content Notifications / Inbox
--
-- Durable notification model for the iOS app and portal hub.
-- Replaces fire-and-forget bot.api.sendMessage() with a persistent
-- inbox that survives app restarts, network outages, and transport
-- failures. Push notifications (APNs) become delivery ADAPTERS on
-- top of this model, not the system of record.
--
-- Notification types:
--   topic_candidates_ready   — new topic candidates generated
--   weekly_package_ready     — weekly content package generated
--   script_ready             — script generated for approved topic
--   content_action_required  — topic needs approval, pipeline stale, etc.
--   performance_logged       — new performance feedback recorded
--   agent_insight            — voice/learning agent produced insight
--
-- iOS reads: GET /api/v1/notifications (unread), POST /:id/read
-- Portal reads: GET /api/notifications (all users, admin view)

CREATE TABLE IF NOT EXISTS content_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    data JSON DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'unread',
    push_sent INTEGER NOT NULL DEFAULT 0,
    push_sent_at TEXT,
    resolved_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_status
    ON content_notifications(user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_type
    ON content_notifications(type, created_at DESC);
