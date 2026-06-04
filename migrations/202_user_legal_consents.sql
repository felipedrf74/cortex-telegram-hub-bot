-- Immutable clickwrap receipts for current Terms/Privacy acceptance.
-- Legal copy remains lawyer-review gated; this table records the fact of
-- acceptance, the document version shown, and privacy-safe request metadata.

CREATE TABLE IF NOT EXISTS user_legal_consents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  document_key TEXT NOT NULL CHECK (document_key IN ('terms', 'privacy')),
  document_version TEXT NOT NULL,
  document_url TEXT NOT NULL,
  locale TEXT,
  source TEXT NOT NULL DEFAULT 'unknown',
  device_id TEXT,
  ip_hash TEXT,
  user_agent_hash TEXT,
  accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, document_key, document_version)
);

CREATE INDEX IF NOT EXISTS idx_user_legal_consents_user
  ON user_legal_consents(user_id, document_key, document_version);
