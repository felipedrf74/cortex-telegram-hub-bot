-- Migration 028: Key-value store for general-purpose persistent storage
CREATE TABLE IF NOT EXISTS kv_store (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_kv_store_updated ON kv_store (updated_at);

-- Rollback: DROP TABLE IF EXISTS kv_store;
