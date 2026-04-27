-- Migration 080: Training session "preferred time unavailable" flag.
--
-- Slice 1.B (coach-engine refactor, 2026-04-27) — when the plan generator
-- cannot land a session at the user's preferred time AND cannot find any
-- alternative window in the day's symmetric ±60/±90/±120/±150-minute
-- candidate band, it walks the day in 30-minute steps to find any free
-- 60-min window. If even that fails, the session falls back to a safe
-- 06:30 marker time so it does not land on top of an existing meeting.
--
-- This flag lets iOS render a ⚠️ chip on the affected session so the user
-- knows they should resolve the conflict manually rather than discovering
-- the wrong time when the meeting overlaps. Default 0 (false) so existing
-- rows are interpreted as "the planner placed this at a fine time".
--
-- Rollback: ALTER TABLE training_sessions DROP COLUMN preferred_time_unavailable;
-- (SQLite only supports DROP COLUMN on >= 3.35 — fine for our deployment.)

ALTER TABLE training_sessions ADD COLUMN preferred_time_unavailable INTEGER NOT NULL DEFAULT 0;
