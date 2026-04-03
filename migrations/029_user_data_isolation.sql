-- Migration 029: Add user_id to all user-facing state tables for multi-user support
-- Existing data defaults to user_id=0 (backward compatible with single-user)

-- Conversations
ALTER TABLE conversations ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_conversations_user_domain ON conversations (user_id, domain, created_at);

-- Todos
ALTER TABLE todos ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_todos_user ON todos (user_id, status);

-- Reminders
ALTER TABLE reminders ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders (user_id, status);

-- Notes
ALTER TABLE notes ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_notes_user ON notes (user_id);

-- Saved Ideas
ALTER TABLE saved_ideas ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_saved_ideas_user ON saved_ideas (user_id);

-- Shared Memory
ALTER TABLE shared_memory ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_shared_memory_user ON shared_memory (user_id);

-- API Usage (per-user cost tracking)
ALTER TABLE api_usage ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_api_usage_user ON api_usage (user_id, ts);

-- Rollback: These columns cannot be easily removed in SQLite (no DROP COLUMN).
-- To rollback, recreate tables without user_id column.
