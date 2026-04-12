-- Migration 063: Push Preferences — server-side notification control
--
-- iOS Settings previously stored push toggles in @AppStorage (local-only).
-- This table makes preferences authoritative and server-enforced:
--   1. Scheduler checks before sending each push
--   2. iOS syncs toggles on change via PUT /settings/push-preferences
--   3. Default: all categories enabled (rows created on first query)
--
-- Categories:
--   morning_briefing   — daily morning report push
--   evening_summary    — end-of-day summary push
--   weekly_review      — Friday weekly review push
--   coach_briefing     — training coach report push
--   content_updates    — content topic/script notifications
--   reminders          — reminder notifications

CREATE TABLE IF NOT EXISTS push_preferences (
    user_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, category)
);
