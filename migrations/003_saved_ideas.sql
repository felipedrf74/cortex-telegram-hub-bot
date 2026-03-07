-- Saved content ideas from /discover feedback loop
CREATE TABLE IF NOT EXISTS saved_ideas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    source_date TEXT NOT NULL,
    status TEXT DEFAULT 'saved',
    created_at TEXT DEFAULT (datetime('now'))
);
