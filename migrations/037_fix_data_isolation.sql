-- P0 Fix 1: limit_conversations trigger must filter by user_id
-- Without this fix, User A's INSERT can delete User B's rows

DROP TRIGGER IF EXISTS limit_conversations;

CREATE TRIGGER IF NOT EXISTS limit_conversations
AFTER INSERT ON conversations
BEGIN
  DELETE FROM conversations
  WHERE user_id = NEW.user_id
    AND domain = NEW.domain
    AND id NOT IN (
      SELECT id FROM conversations
      WHERE user_id = NEW.user_id AND domain = NEW.domain
      ORDER BY created_at DESC
      LIMIT 20
    );
END;

-- P0 Fix 2: shared_memory UNIQUE constraint must include user_id
-- Without this fix, two users setting the same key overwrite each other
-- SQLite can't ALTER a UNIQUE constraint, so we rebuild the table

CREATE TABLE IF NOT EXISTS shared_memory_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 0,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source_domain TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, key)
);

INSERT OR IGNORE INTO shared_memory_new (id, user_id, key, value, source_domain, expires_at, created_at, updated_at)
  SELECT id, user_id, key, value, source_domain, expires_at, created_at, updated_at FROM shared_memory;

DROP TABLE IF EXISTS shared_memory;
ALTER TABLE shared_memory_new RENAME TO shared_memory;

CREATE INDEX IF NOT EXISTS idx_shared_memory_user ON shared_memory (user_id);
