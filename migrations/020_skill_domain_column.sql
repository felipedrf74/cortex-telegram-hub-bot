-- Migration 020: Add domain column to installed_skills
-- Allows efficient lookup of skills by domain (secretary, triathlon, content, etc.)

ALTER TABLE installed_skills ADD COLUMN domain TEXT;
CREATE INDEX IF NOT EXISTS idx_skills_domain ON installed_skills(domain);
