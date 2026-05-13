-- Migration 126: reserved by feature/secretary-reasoning-orchestration-2026-05
--
-- Reservation date: 2026-05-13
-- Purpose: placeholder for Secretary reasoning trail support. The reasoning trail
-- (W-E workstream) is added via PRAGMA table_info / ALTER TABLE pattern on
-- secretary_agenda_items at runtime, matching the existing arbitrator pattern
-- at secretary-scheduling-arbitrator.ts:220-225. This migration number is
-- reserved so Codex's parallel chat-logic work can claim 127+ without collision.
--
-- If a schema change is later required (e.g., dedicated reasoning_trail table
-- with retention), it lands here as a real migration. Until then, this file
-- is a no-op SELECT to keep the migration runner happy.

SELECT 1;
