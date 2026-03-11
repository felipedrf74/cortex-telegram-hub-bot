-- Content Engine: Phase 1 — Research Core tables

CREATE TABLE IF NOT EXISTS content_research_briefs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,
  title TEXT NOT NULL,
  hook TEXT NOT NULL DEFAULT '',
  angle TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT 'YouTube',
  niche TEXT NOT NULL DEFAULT '',
  key_points TEXT DEFAULT '[]',           -- JSON array
  title_options TEXT DEFAULT '[]',        -- JSON array
  sources TEXT DEFAULT '[]',              -- JSON array of {title, url, source_type, relevance_note}
  score REAL DEFAULT 0.0,
  time_sensitive INTEGER DEFAULT 0,       -- boolean
  why_now TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS content_search_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brief_id INTEGER REFERENCES content_research_briefs(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  snippet TEXT DEFAULT '',
  source TEXT NOT NULL,                   -- 'web', 'youtube', 'news'
  published_at TEXT,
  thumbnail_url TEXT,
  metadata TEXT DEFAULT '{}',             -- JSON
  relevance_score REAL DEFAULT 0.0,
  virality_score REAL DEFAULT 0.0,
  recency_score REAL DEFAULT 0.0,
  composite_score REAL DEFAULT 0.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS content_search_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_key TEXT NOT NULL UNIQUE,         -- hash of searcher + query + params
  results TEXT NOT NULL,                  -- JSON array of SearchResult
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS content_trending_topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  heat_score REAL DEFAULT 0.0,
  sources TEXT DEFAULT '[]',              -- JSON array of source names
  niche TEXT DEFAULT '',
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_research_briefs_query ON content_research_briefs(query);
CREATE INDEX IF NOT EXISTS idx_research_briefs_created ON content_research_briefs(created_at);
CREATE INDEX IF NOT EXISTS idx_search_results_brief ON content_search_results(brief_id);
CREATE INDEX IF NOT EXISTS idx_search_cache_key ON content_search_cache(cache_key);
CREATE INDEX IF NOT EXISTS idx_search_cache_expires ON content_search_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_trending_topics_score ON content_trending_topics(heat_score DESC);
