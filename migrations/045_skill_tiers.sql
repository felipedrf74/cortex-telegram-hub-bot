-- Migration 045: Skill tier catalog + per-user overrides + default bump
--
-- Phase 1 foundation. Introduces the *tier requirement* dimension for the
-- skill catalog: every skill (or sub-skill) can declare a minimum tier the
-- user must have to access it. The runtime gate lives in
-- src/services/skill-tiers.ts.
--
-- Design decisions locked in Phase 1 planning:
--  - Tiers: owner > pro > free (matches existing users.tier enum)
--  - Gate check: user.tier >= skill.required_tier  (ordinal comparison)
--  - Per-user overrides are supported but SPARSE — the common path reads
--    the catalog + user.tier only. Overrides exist for one-off unlocks
--    (power users, beta testers) without needing to create a new tier.
--  - The existing user_skill_overrides table (migration 032) stores
--    admin-driven ENABLE/DISABLE flags. This migration adds the ORTHOGONAL
--    TIER dimension — a user can be tier=free (blocked by catalog) AND
--    have an override that unlocks a specific skill.
--
-- Everyone who is currently on 'free' is bumped to 'pro' so nothing they
-- had access to yesterday disappears under their feet (user instruction:
-- "from start everyone starts with all skills and I disable if needed
-- manually"). New signups still default to 'free' at the SQL layer —
-- user-service.ts bumps the INSERT path to 'pro' in code, so the SQL
-- default stays as a safe fallback.

-- ── Catalog: which tier is required for which skill ──────────────────

CREATE TABLE IF NOT EXISTS skill_tiers (
  skill_id       TEXT PRIMARY KEY,         -- e.g. 'triathlon.gym', 'secretary.tasks'
  required_tier  TEXT NOT NULL DEFAULT 'pro',
  description    TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (required_tier IN ('free', 'pro', 'owner'))
);

CREATE INDEX IF NOT EXISTS idx_skill_tiers_required ON skill_tiers (required_tier);

-- ── Per-user overrides: sparse table for one-off unlocks ─────────────

CREATE TABLE IF NOT EXISTS user_skill_tier_overrides (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL,
  skill_id       TEXT NOT NULL,
  unlocked       INTEGER NOT NULL DEFAULT 1,   -- 1 = grant access regardless of user.tier
  reason         TEXT,
  granted_by     INTEGER,                      -- telegram_id of admin who granted it
  granted_at     TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at     TEXT,                          -- NULL = permanent
  UNIQUE (user_id, skill_id)
);

CREATE INDEX IF NOT EXISTS idx_user_skill_tier_user ON user_skill_tier_overrides (user_id);
CREATE INDEX IF NOT EXISTS idx_user_skill_tier_expires ON user_skill_tier_overrides (expires_at) WHERE expires_at IS NOT NULL;

-- ── Seed the catalog with Phase 1 skill tiers ────────────────────────
--
-- Secretary is the "free tier anchor" — every user, even free, gets
-- basic tasks/calendar/reminders/notes. Everything else is 'pro' by
-- default. 'owner' is reserved for administrative tooling (currently
-- nothing uses it, but the column accepts it for future skills like
-- "impersonate user" or "view audit log").

INSERT OR IGNORE INTO skill_tiers (skill_id, required_tier, description) VALUES
  -- Secretary — free tier foundation
  ('secretary',              'free', 'Personal assistant parent skill'),
  ('secretary.tasks',        'free', 'Microsoft To Do task management'),
  ('secretary.calendar',     'free', 'Google + Outlook calendar'),
  ('secretary.email',        'free', 'Outlook email read/send/reply'),
  ('secretary.reminders',    'free', 'Time-based reminders'),
  ('secretary.notes',        'free', 'Note saving and search'),
  ('secretary.shared-memory','free', 'Cross-domain shared facts'),
  ('secretary.briefings',    'free', 'Morning briefing and daily digest'),

  -- Triathlon — parent + sport sub-skills (all pro)
  ('triathlon',              'pro',  'Triathlon coaching parent skill'),
  ('triathlon.gym',          'pro',  'Strength training coach (powerlifting, hypertrophy, general fitness)'),
  ('triathlon.running',      'pro',  'Running coach (5k/10k/HM/marathon, intervals, tempo)'),
  ('triathlon.cycle',        'pro',  'Cycling coach (FTP, zones, road/gravel/trainer)'),
  ('triathlon.swim',         'pro',  'Swim coach (stroke technique, pool/open water)'),
  ('triathlon.training-plans','pro', 'AI-generated periodized training plans'),
  ('triathlon.calendar',     'pro',  'Training calendar event management'),
  ('triathlon.reminders',    'pro',  'Training reminders'),
  ('triathlon.notes',        'pro',  'Training notes and search'),
  ('triathlon.shared-memory','pro',  'Cross-domain shared facts (race dates, training state)'),
  ('triathlon.recovery',     'pro',  'Recovery protocols and adaptive deload'),

  -- Content creation — pro
  ('content',                'pro',  'Content creation parent skill'),
  ('content.notes',          'pro',  'Content ideas and research notes'),
  ('content.shared-memory',  'pro',  'Cross-domain shared facts'),
  ('content.research-pipeline','pro','Channel re-learning and reference analysis'),
  ('content.script-generator','pro', 'AI script generation'),
  ('content.seo-tracker',    'pro',  'YouTube keyword rank tracking'),
  ('content.reaction-radar', 'pro',  'Trending content monitor'),
  ('content.voice-evolution','pro',  'Script vs transcript voice learning'),
  ('content.performance-intel','pro','Channel performance analysis'),
  ('content.pipeline-tracker','pro', 'Content pipeline stage tracking'),
  ('content.topic-scheduler','pro',  'Automated Reels/YouTube topic generation'),
  ('content.meme-scout',     'pro',  'Meme discovery (experimental)'),

  -- Finance — pro
  ('finance',                'pro',  'Personal finance parent skill'),
  ('finance.expenses',       'pro',  'Expense tracking'),
  ('finance.tax',            'pro',  'DARF and Carnê-Leão tax calculation'),
  ('finance.receipts',       'pro',  'Receipt analysis and categorization'),

  -- Cooking — pro
  ('cooking',                'pro',  'Cooking parent skill'),
  ('cooking.meal-planning',  'pro',  'Weekly meal planning'),
  ('cooking.recipes',        'pro',  'Recipe search and generation');

-- ── Bulk-upgrade existing free users to pro ──────────────────────────
--
-- User instruction from Phase 1 planning: "from start everyone starts
-- with all skills and I disable if needed manually". Bump all existing
-- 'free' users to 'pro' and give them the pro limits from user-service.
-- This is safe because it can only *widen* access — no user loses any
-- skill they could use yesterday.
--
-- The new limits mirror user-service.ts setUserTier('pro'):
--   daily_message_limit = 200
--   daily_token_limit   = 500000
--   daily_cost_limit_usd= 5.0

UPDATE users
SET tier = 'pro',
    daily_message_limit = 200,
    daily_token_limit   = 500000,
    daily_cost_limit_usd = 5.0
WHERE tier = 'free';

-- Rollback:
--   UPDATE users SET tier = 'free', daily_message_limit = 40, daily_token_limit = 100000, daily_cost_limit_usd = 0 WHERE tier = 'pro';
--   DROP TABLE IF EXISTS user_skill_tier_overrides;
--   DROP TABLE IF EXISTS skill_tiers;
