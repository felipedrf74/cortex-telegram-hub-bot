-- Migration 017: Pipeline publish tracking
-- Sprint 3.1: Add published_url and published_at to content_pipeline

ALTER TABLE content_pipeline ADD COLUMN published_url TEXT;
ALTER TABLE content_pipeline ADD COLUMN published_at TEXT;
