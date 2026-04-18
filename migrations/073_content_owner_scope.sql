-- Migration 073: Replace implicit content user_id=0 semantics with explicit owner scope.
-- We keep the columns nullable for now so older inserts/tests remain readable while
-- the runtime moves to explicit system/user ownership.

ALTER TABLE content_ref_channels ADD COLUMN owner_scope TEXT;
UPDATE content_ref_channels
   SET owner_scope = CASE WHEN user_id = 0 THEN 'system' ELSE 'user' END
 WHERE owner_scope IS NULL;
CREATE INDEX IF NOT EXISTS idx_content_ref_channels_scope
  ON content_ref_channels(owner_scope, user_id, status);

ALTER TABLE content_knowledge RENAME TO content_knowledge_legacy_073;

CREATE TABLE content_knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  synthesized_text TEXT NOT NULL,
  source_channels TEXT DEFAULT '[]',
  version INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER NOT NULL DEFAULT 0,
  owner_scope TEXT,
  UNIQUE(user_id, category)
);

INSERT INTO content_knowledge (
  id, category, synthesized_text, source_channels, version, created_at, updated_at, user_id, owner_scope
)
SELECT
  id,
  category,
  synthesized_text,
  source_channels,
  version,
  created_at,
  updated_at,
  user_id,
  CASE WHEN user_id = 0 THEN 'system' ELSE 'user' END
FROM content_knowledge_legacy_073;

DROP TABLE content_knowledge_legacy_073;

CREATE INDEX IF NOT EXISTS idx_content_knowledge_user ON content_knowledge(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_knowledge_user_category
  ON content_knowledge(user_id, category);
CREATE INDEX IF NOT EXISTS idx_content_knowledge_scope
  ON content_knowledge(owner_scope, user_id, category);

ALTER TABLE book_library RENAME TO book_library_legacy_073;

CREATE TABLE book_library (
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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER NOT NULL DEFAULT 0,
  owner_scope TEXT,
  UNIQUE(user_id, title, author)
);

INSERT INTO book_library (
  id, title, author, core_thesis, key_frameworks, quotable_ideas, pillar_mapping,
  personal_notes, extraction_status, extraction_date, times_referenced,
  best_performing_framework, created_at, user_id, owner_scope
)
SELECT
  id,
  title,
  author,
  core_thesis,
  key_frameworks,
  quotable_ideas,
  pillar_mapping,
  personal_notes,
  extraction_status,
  extraction_date,
  times_referenced,
  best_performing_framework,
  created_at,
  user_id,
  CASE WHEN user_id = 0 THEN 'system' ELSE 'user' END
FROM book_library_legacy_073;

DROP TABLE book_library_legacy_073;

CREATE UNIQUE INDEX IF NOT EXISTS idx_book_library_user_unique
  ON book_library(user_id, title, author);
CREATE INDEX IF NOT EXISTS idx_book_library_user ON book_library(user_id);
CREATE INDEX IF NOT EXISTS idx_book_library_scope
  ON book_library(owner_scope, user_id, title, author);

ALTER TABLE content_learned_patterns ADD COLUMN owner_scope TEXT;
UPDATE content_learned_patterns
   SET owner_scope = CASE WHEN user_id = 0 THEN 'system' ELSE 'user' END
 WHERE owner_scope IS NULL;
CREATE INDEX IF NOT EXISTS idx_content_learned_patterns_scope
  ON content_learned_patterns(owner_scope, user_id, category);
