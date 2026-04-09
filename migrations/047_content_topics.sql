-- Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
--
-- Migration 047 — Content topic scheduler (TASK-14 Phase 2)
--
-- Adds a new table for user-created topics with optional publish dates.
-- This is distinct from `content_topic_feedback` (which holds AI-suggested
-- topic candidates with approval sentiment) — this table is the user's
-- OWN scheduled topics for the Content skill landing page's Topic
-- scheduler card.
--
-- Status lifecycle:
--   planned    — captured the idea, not started
--   drafting   — actively writing / outlining
--   ready      — ready to film / record
--   published  — shipped (terminal)
--   cancelled  — abandoned (terminal, hidden by default)
--
-- scheduled_date is nullable: topics without a date are "unscheduled"
-- captures that the user wants to address eventually. The iOS UI
-- groups them into a separate "Later" section.

CREATE TABLE IF NOT EXISTS content_topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    notes TEXT,
    scheduled_date TEXT,              -- YYYY-MM-DD, nullable
    status TEXT NOT NULL DEFAULT 'planned'
        CHECK (status IN ('planned', 'drafting', 'ready', 'published', 'cancelled')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Primary access pattern: filter by user_id, optionally by status,
-- sort by scheduled_date ascending. A composite index on
-- (user_id, scheduled_date) covers the main list query.
CREATE INDEX IF NOT EXISTS idx_content_topics_user
    ON content_topics (user_id);

CREATE INDEX IF NOT EXISTS idx_content_topics_user_scheduled
    ON content_topics (user_id, scheduled_date);

-- Status filter index — used by the "unscheduled" + "published"
-- quick filters in the iOS UI.
CREATE INDEX IF NOT EXISTS idx_content_topics_user_status
    ON content_topics (user_id, status);
