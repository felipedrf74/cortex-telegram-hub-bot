-- Migration 071 — per-user Reaction Radar preferences
--
-- Lets each creator define the topics/angles they want Reaction Radar
-- to prioritize on the iOS Content surfaces. The scheduled radar agent
-- can stay global for now while the user-facing discovery experience
-- becomes per-user.

CREATE TABLE IF NOT EXISTS content_radar_preferences (
    user_id INTEGER PRIMARY KEY,
    topics_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
