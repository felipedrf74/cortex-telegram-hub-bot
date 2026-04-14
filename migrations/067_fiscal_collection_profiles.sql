-- 067_fiscal_collection_profiles.sql
--
-- User-scoped fiscal collection preferences for the accountant bundle flow.
-- This sits above the existing invoice_vendors rule table:
--   - invoice_vendors     = what to match in email
--   - fiscal_collection_profiles = when/how to consolidate and where to send it

CREATE TABLE IF NOT EXISTS fiscal_collection_profiles (
  user_id                    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  destination_email          TEXT,
  cadence                    TEXT NOT NULL DEFAULT 'monthly',
  primary_day                INTEGER NOT NULL DEFAULT 28,
  secondary_day              INTEGER,
  enabled                    INTEGER NOT NULL DEFAULT 1,
  last_bundle_sent_at        TEXT,
  last_bundle_document_count INTEGER NOT NULL DEFAULT 0,
  created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                 TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fiscal_collection_profiles_enabled
  ON fiscal_collection_profiles(enabled);
