-- Migration 056: Add user_id to content enrichment tables for multi-user isolation.
-- Existing data defaults to user_id=0 (backward compatible with owner/single-user).
-- Each user gets their own books, YouTube channels, voice DNA, and pillars.

-- ── Book Library ──────────────────────────────────────────────────
ALTER TABLE book_library ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_book_library_user ON book_library(user_id);

-- ── Content Reference Channels ────────────────────────────────────
ALTER TABLE content_ref_channels ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_content_ref_channels_user ON content_ref_channels(user_id);

-- ── Content Knowledge (Voice DNA) ─────────────────────────────────
-- Check if user_id already exists before adding
-- (content_knowledge may already have it from an earlier migration)
-- SQLite doesn't support IF NOT EXISTS for ALTER TABLE, so we wrap in a try
-- The migration runner handles duplicate column errors gracefully.
ALTER TABLE content_knowledge ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_content_knowledge_user ON content_knowledge(user_id);

-- ── Config Seed Books ─────────────────────────────────────────────
-- Already has user_id? No — add it. Users can have their own book seeds.
-- The config_seed_books from migration 055 are global (user_id=0).
-- Per-user books override global when user_id != 0.

-- ── Config Pillars ────────────────────────────────────────────────
-- Already has user_id from the initial creation. Verify index.
CREATE INDEX IF NOT EXISTS idx_config_pillars_user ON config_pillars(user_id);
