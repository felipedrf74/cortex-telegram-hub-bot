-- To-do items
CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    domain TEXT DEFAULT 'general',
    priority TEXT DEFAULT 'medium',
    status TEXT DEFAULT 'pending',
    due_date TEXT,
    tags TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
);

-- Quick notes
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    domain TEXT DEFAULT 'general',
    tags TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Reminders
CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT NOT NULL,
    remind_at TEXT NOT NULL,
    recurring TEXT,
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now'))
);

-- Conversation history (per domain, for context continuity)
CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Keep only last 20 messages per domain for context window management
CREATE TRIGGER IF NOT EXISTS limit_conversations
AFTER INSERT ON conversations
BEGIN
    DELETE FROM conversations
    WHERE id NOT IN (
        SELECT id FROM conversations
        WHERE domain = NEW.domain
        ORDER BY created_at DESC
        LIMIT 20
    ) AND domain = NEW.domain;
END;
