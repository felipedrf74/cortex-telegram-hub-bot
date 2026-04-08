-- Migration 046: Per-user dimension on agent_signals for training coaches
--
-- Phase 1, Slice B. Content-mesh signals (hook_effectiveness, pillar_performance,
-- etc.) are GLOBAL — they describe channel-level truths that apply to every
-- reader. Training signals are the opposite: Felipe's `high_leg_load` after
-- squats should not affect another user's run prescription.
--
-- Adds a nullable `user_id` column to agent_signals:
--  - NULL  → global signal (content mesh default, preserves existing behavior)
--  - value → scoped to that telegram user id (training coach signals)
--
-- The bus layer (src/services/intelligence-bus.ts) will filter by user_id
-- on reads — when a reader passes a userId, it gets global + its own signals;
-- when it passes nothing, it gets global only (unchanged from today).
--
-- Index on (user_id, signal_type) so per-user reads stay cheap even as
-- training signals accumulate over weeks.

ALTER TABLE agent_signals ADD COLUMN user_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_signals_user_type ON agent_signals (user_id, signal_type)
  WHERE user_id IS NOT NULL;

-- Rollback:
--   DROP INDEX IF EXISTS idx_signals_user_type;
--   (cannot DROP COLUMN in SQLite without a table rewrite — leave the column
--   in place if rolling back; it's nullable so existing writes are unaffected)
