-- Migration 016: Unify idea storage + angle tracking
-- Sprint 2: Route all ideas into SQLite, add angle diversity tracking

-- Extend saved_ideas with source, score, workflow eligibility
ALTER TABLE saved_ideas ADD COLUMN source TEXT DEFAULT 'manual';
ALTER TABLE saved_ideas ADD COLUMN score REAL DEFAULT 0.0;
ALTER TABLE saved_ideas ADD COLUMN workflow_eligible INTEGER DEFAULT 0;
ALTER TABLE saved_ideas ADD COLUMN angle_tag TEXT;
ALTER TABLE saved_ideas ADD COLUMN niche TEXT;
ALTER TABLE saved_ideas ADD COLUMN hook_idea TEXT;
ALTER TABLE saved_ideas ADD COLUMN why_now TEXT;

CREATE INDEX IF NOT EXISTS idx_saved_ideas_source ON saved_ideas(source);
CREATE INDEX IF NOT EXISTS idx_saved_ideas_eligible ON saved_ideas(workflow_eligible);
CREATE INDEX IF NOT EXISTS idx_saved_ideas_angle ON saved_ideas(angle_tag);

-- Add angle tracking to content_topic_feedback
ALTER TABLE content_topic_feedback ADD COLUMN angle_tag TEXT;
