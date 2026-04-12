-- Migration 059: Content Learning Store
--
-- Creates the canonical DB-backed learning model for content.
-- Replaces feedback.json with durable storage and adds:
--   1. content_scripts — raw script text (survives DOCX file deletion)
--   2. content_performance — per-video performance feedback (replaces feedback.json)
--   3. content_learned_patterns — durable voice/content patterns (survive signal expiry)
--
-- Together with the existing content_topic_feedback, content_pipeline,
-- and video_transcripts tables, this completes the artifact chain:
--   idea → topic_feedback → pipeline → script → publish → transcript → performance → pattern
--
-- All tables use user_id for multi-tenant isolation.

-- ═══════════════════════════════════════════════════════════════════
-- 1. content_scripts — raw script text stored durably
-- ═══════════════════════════════════════════════════════════════════
-- Previously, only the DOCX file path was stored in content_pipeline.script_path.
-- If the file was deleted, the script text was lost. Now we persist the full text,
-- hook, title options, and sources in the DB alongside the file path.

CREATE TABLE IF NOT EXISTS content_scripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pipeline_id INTEGER,
    topic_feedback_id INTEGER,
    topic TEXT NOT NULL,
    format TEXT NOT NULL DEFAULT 'youtube',
    script_text TEXT NOT NULL,
    hook TEXT,
    title_options JSON DEFAULT '[]',
    sources_used JSON DEFAULT '[]',
    estimated_duration TEXT,
    niche TEXT,
    generation_duration_ms INTEGER,
    user_id INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (pipeline_id) REFERENCES content_pipeline(id),
    FOREIGN KEY (topic_feedback_id) REFERENCES content_topic_feedback(id)
);

CREATE INDEX IF NOT EXISTS idx_content_scripts_pipeline ON content_scripts(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_content_scripts_user ON content_scripts(user_id);
CREATE INDEX IF NOT EXISTS idx_content_scripts_created ON content_scripts(created_at);

-- ═══════════════════════════════════════════════════════════════════
-- 2. content_performance — per-video performance feedback
-- ═══════════════════════════════════════════════════════════════════
-- Replaces content-engine/data/feedback.json with durable DB storage.
-- Links to content_pipeline (and transitively to scripts, topics, ideas)
-- so every performance metric traces back to the source artifacts.

CREATE TABLE IF NOT EXISTS content_performance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pipeline_id INTEGER,
    video_url TEXT,
    views INTEGER DEFAULT 0,
    retention_pct REAL DEFAULT 0,
    likes INTEGER DEFAULT 0,
    comments INTEGER DEFAULT 0,
    subs_gained INTEGER DEFAULT 0,
    hook_used TEXT,
    notes TEXT,
    analysis JSON,
    user_id INTEGER NOT NULL DEFAULT 0,
    logged_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (pipeline_id) REFERENCES content_pipeline(id)
);

CREATE INDEX IF NOT EXISTS idx_content_perf_pipeline ON content_performance(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_content_perf_user ON content_performance(user_id);
CREATE INDEX IF NOT EXISTS idx_content_perf_logged ON content_performance(logged_at);

-- ═══════════════════════════════════════════════════════════════════
-- 3. content_learned_patterns — durable voice/content patterns
-- ═══════════════════════════════════════════════════════════════════
-- Intelligence bus signals expire (voice_pattern: 90 days, hook_effectiveness: 60 days).
-- This table persists learned patterns permanently. The voice-evolution-agent
-- writes here on each monthly run; patterns accumulate over time and never expire.
--
-- category values:
--   voice_addition    — phrases/patterns Felipe adds to AI scripts
--   voice_removal     — what he consistently removes/shortens
--   voice_rephrasing  — how he rephrases AI text to his own voice
--   hook_pattern      — hook styles that perform well
--   retention_driver  — content patterns that improve retention
--   pillar_insight    — which content pillars resonate most
--   book_influence    — book concepts integrated into voice

CREATE TABLE IF NOT EXISTS content_learned_patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    pattern_text TEXT NOT NULL,
    examples JSON DEFAULT '[]',
    confidence REAL DEFAULT 0.5,
    frequency INTEGER DEFAULT 1,
    source_agent TEXT,
    first_detected_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    user_id INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_learned_patterns_category ON content_learned_patterns(category);
CREATE INDEX IF NOT EXISTS idx_learned_patterns_user ON content_learned_patterns(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_learned_patterns_unique
    ON content_learned_patterns(category, pattern_text, user_id);
