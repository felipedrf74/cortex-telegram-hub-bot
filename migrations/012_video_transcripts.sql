-- Migration 012: Video Transcripts & Study Results
-- Date: 2026-03-17

-- Cached video transcripts (avoid re-fetching)
CREATE TABLE IF NOT EXISTS video_transcripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL,                     -- YouTube video ID (11 chars)
  title TEXT,
  channel_name TEXT,
  language TEXT DEFAULT 'en',
  full_text TEXT NOT NULL,                    -- Complete transcript text
  hook_text TEXT,                             -- First 30 seconds of transcript
  duration_seconds INTEGER,
  is_auto_generated INTEGER DEFAULT 0,        -- boolean
  segment_count INTEGER DEFAULT 0,
  char_count INTEGER DEFAULT 0,
  ref_channel_id INTEGER,                     -- FK to content_ref_channels (NULL for standalone)
  source TEXT DEFAULT 'manual',               -- 'manual' | 'channel_analysis' | 'study'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_transcript_video ON video_transcripts(video_id);
CREATE INDEX IF NOT EXISTS idx_transcript_channel ON video_transcripts(ref_channel_id);

-- Video study results (deep analysis output)
CREATE TABLE IF NOT EXISTS video_studies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL,
  transcript_id INTEGER REFERENCES video_transcripts(id) ON DELETE CASCADE,
  study_type TEXT NOT NULL DEFAULT 'full',     -- 'full' | 'hook' | 'reel_cuts' | 'content_ideas'
  analysis_json TEXT NOT NULL,                 -- Full Claude analysis as JSON
  hook_analysis TEXT,                          -- First 30s breakdown
  structure_breakdown TEXT,                    -- Section-by-section analysis
  key_moments TEXT DEFAULT '[]',               -- JSON array of notable moments
  content_ideas TEXT DEFAULT '[]',             -- JSON array of inspired ideas
  reel_cuts TEXT DEFAULT '[]',                 -- JSON array of suggested short/reel cuts
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_study_video ON video_studies(video_id);

-- Rollback:
-- DROP TABLE IF EXISTS video_studies;
-- DROP TABLE IF EXISTS video_transcripts;
