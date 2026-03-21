-- Migration 013: Content Workflow — Topic Feedback & Taste Learning
-- Stores topic candidates and user feedback (approve/skip/reject) for the
-- weekly content workflow scheduler. Enables taste profile learning.

CREATE TABLE IF NOT EXISTS content_topic_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  niche TEXT,                                         -- e.g. 'fitness', 'politics', 'self-development'
  format TEXT NOT NULL,                               -- 'reel' | 'youtube'
  sentiment TEXT NOT NULL DEFAULT 'pending',           -- 'pending' | 'approved' | 'skipped' | 'rejected'
  source_job TEXT,                                    -- 'tuesday_reels' | 'thursday_youtube' | 'friday_weekly'
  hook_idea TEXT,
  why_now TEXT,
  script_generated INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_feedback_sentiment ON content_topic_feedback(sentiment);
CREATE INDEX IF NOT EXISTS idx_feedback_format ON content_topic_feedback(format);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON content_topic_feedback(created_at);
