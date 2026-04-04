-- Migration 036: Add skill_preset column to invite_codes
-- Stores a JSON object mapping skill names to enabled/disabled state

ALTER TABLE invite_codes ADD COLUMN skill_preset TEXT;
