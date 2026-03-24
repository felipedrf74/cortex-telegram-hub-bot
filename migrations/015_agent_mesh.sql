-- Migration 015: Content Agent Mesh System
-- Intelligence Bus + Book Library + Content Pipeline + Agent Run History

-- Intelligence Bus
CREATE TABLE IF NOT EXISTS agent_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_agent TEXT NOT NULL,
    signal_type TEXT NOT NULL,
    payload JSON NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal',
    consumed_by JSON NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signals_active ON agent_signals(status, signal_type);
CREATE INDEX IF NOT EXISTS idx_signals_source ON agent_signals(source_agent, created_at);

-- Book Knowledge
CREATE TABLE IF NOT EXISTS book_library (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    core_thesis TEXT,
    key_frameworks JSON DEFAULT '[]',
    quotable_ideas JSON DEFAULT '[]',
    pillar_mapping JSON DEFAULT '[]',
    personal_notes JSON DEFAULT '[]',
    extraction_status TEXT NOT NULL DEFAULT 'pending',
    extraction_date TEXT,
    times_referenced INTEGER DEFAULT 0,
    best_performing_framework TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_book_unique ON book_library(title, author);

-- Content Pipeline State
CREATE TABLE IF NOT EXISTS content_pipeline (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_feedback_id INTEGER,
    topic_title TEXT NOT NULL,
    niche TEXT,
    stage TEXT NOT NULL DEFAULT 'approved',
    script_path TEXT,
    drive_url TEXT,
    youtube_video_id TEXT,
    stage_history JSON NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (topic_feedback_id) REFERENCES content_topic_feedback(id)
);
CREATE INDEX IF NOT EXISTS idx_pipeline_stage ON content_pipeline(stage);

-- Agent Run History
CREATE TABLE IF NOT EXISTS agent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    status TEXT NOT NULL,
    signals_produced INTEGER DEFAULT 0,
    signals_consumed INTEGER DEFAULT 0,
    duration_ms INTEGER,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_runs ON agent_runs(agent_name, created_at);
