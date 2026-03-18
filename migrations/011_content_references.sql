-- Migration 011: Content Creator Reference Channels & Learned Patterns
-- Date: 2026-03-17

-- Reference channels that the bot learns from
CREATE TABLE IF NOT EXISTS content_ref_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_url TEXT NOT NULL,               -- YouTube channel URL or handle
  channel_name TEXT,                        -- Resolved display name
  channel_id TEXT,                          -- YouTube channel ID (resolved via API)
  status TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'analyzing' | 'active' | 'failed'
  last_analyzed_at TEXT,
  video_count_analyzed INTEGER DEFAULT 0,
  error_message TEXT,
  added_via TEXT DEFAULT 'manual',          -- 'manual' | 'portal' | 'bot'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ref_channels_url ON content_ref_channels(channel_url);

-- Extracted patterns from reference channels (accumulated knowledge)
CREATE TABLE IF NOT EXISTS content_patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER REFERENCES content_ref_channels(id) ON DELETE CASCADE,
  category TEXT NOT NULL,                   -- 'hook_style' | 'title_pattern' | 'content_structure' | 'editing_style' | 'storytelling' | 'cta_pattern' | 'audience_engagement' | 'visual_style' | 'brand_voice'
  pattern_text TEXT NOT NULL,               -- The extracted pattern/insight
  examples TEXT DEFAULT '[]',               -- JSON array of concrete examples from the channel
  confidence REAL DEFAULT 0.8,              -- 0.0-1.0 how confident we are in this pattern
  source_videos TEXT DEFAULT '[]',          -- JSON array of video titles that demonstrated this pattern
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_patterns_channel ON content_patterns(channel_id);
CREATE INDEX IF NOT EXISTS idx_patterns_category ON content_patterns(category);

-- Synthesized knowledge (merged insights across all channels)
-- This is what gets injected into the content domain's system prompt
CREATE TABLE IF NOT EXISTS content_knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL UNIQUE,            -- Same categories as content_patterns
  synthesized_text TEXT NOT NULL,           -- Merged, deduplicated knowledge
  source_channels TEXT DEFAULT '[]',        -- JSON array of channel names that contributed
  version INTEGER DEFAULT 1,               -- Increments on each re-synthesis
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_category ON content_knowledge(category);

-- Rollback:
-- DROP TABLE IF EXISTS content_knowledge;
-- DROP TABLE IF EXISTS content_patterns;
-- DROP TABLE IF EXISTS content_ref_channels;
