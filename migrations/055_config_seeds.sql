-- Config seed tables — move hardcoded constants from TypeScript to DB.
-- The code now reads from these tables instead of in-memory arrays.
-- Seeds are inserted ONLY if tables are empty (idempotent migration).

-- ── Seed Books ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS config_seed_books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(title, author)
);

-- Seed the 6 default books (libertarian canon)
INSERT OR IGNORE INTO config_seed_books (title, author) VALUES
  ('The Law', 'Frédéric Bastiat'),
  ('Economics in One Lesson', 'Henry Hazlitt'),
  ('Human Action', 'Ludwig von Mises'),
  ('The Road to Serfdom', 'Friedrich Hayek'),
  ('Democracy: The God That Failed', 'Hans-Hermann Hoppe'),
  ('Anatomy of the State', 'Murray Rothbard');

-- ── Default Channels ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS config_default_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  enabled INTEGER DEFAULT 1,
  added_via TEXT DEFAULT 'migration',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Seed the 4 default YouTube channels
INSERT OR IGNORE INTO config_default_channels (url) VALUES
  ('https://www.youtube.com/@danielbarada'),
  ('https://www.youtube.com/@NewelOfKnowledge'),
  ('https://www.youtube.com/@Jett.franzen'),
  ('https://www.youtube.com/@DanKoeTalks');
