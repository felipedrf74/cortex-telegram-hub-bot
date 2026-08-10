-- First-container release schema convergence.
--
-- The live PM2 databases contain a small amount of runtime-created schema and
-- three obsolete global-uniqueness indexes that migration 058 already replaced
-- with tenant-safe composite indexes. This migration makes that state explicit
-- and reproducible before the first container release. Every change is safe for
-- the predecessor: tables/columns/indexes are additive, and removing the three
-- obsolete indexes only relaxes constraints superseded by the per-user indexes.

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_ref_channels_user_url
  ON content_ref_channels(user_id, channel_url);
CREATE UNIQUE INDEX IF NOT EXISTS idx_video_transcripts_user_video
  ON video_transcripts(user_id, video_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_vendors_user_sender
  ON invoice_vendors(user_id, sender_pattern);

DROP INDEX IF EXISTS idx_ref_channels_url;
DROP INDEX IF EXISTS idx_transcript_video;
DROP INDEX IF EXISTS idx_vendor_sender;

CREATE TABLE IF NOT EXISTS ai_provider_attempt_reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  request_source TEXT NOT NULL,
  base_category TEXT NOT NULL,
  job_name TEXT,
  run_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  provider_category TEXT NOT NULL,
  reserved_cost_usd REAL NOT NULL CHECK (reserved_cost_usd >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_provider_attempt_reservations_run
  ON ai_provider_attempt_reservations(request_source, base_category, run_id, user_id);
CREATE INDEX IF NOT EXISTS idx_ai_provider_attempt_reservations_job
  ON ai_provider_attempt_reservations(request_source, base_category, run_id, job_name, user_id);

-- The content artifact store owns this runtime-created table today. Capture its
-- pre-feedback shape so a clean cumulative migration rehearsal and either live
-- database take the same ADD COLUMN path below.
CREATE TABLE IF NOT EXISTS content_idea_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  topic_hash TEXT NOT NULL,
  hook_hash TEXT NOT NULL,
  topic TEXT NOT NULL,
  hook TEXT,
  angle TEXT,
  format TEXT,
  source_package_id TEXT,
  accepted INTEGER NOT NULL DEFAULT 0,
  used_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(tenant_id, user_id, topic_hash, hook_hash)
);
CREATE INDEX IF NOT EXISTS idx_content_idea_memory_recent
  ON content_idea_memory(tenant_id, user_id, used_at DESC);

-- Create the pre-invite shape when the runtime-owned table is absent. The
-- governed migration runner filters an ADD COLUMN only when that exact column
-- already exists, so both a fresh database and either live variant converge.
CREATE TABLE IF NOT EXISTS google_auth_pending_sessions (
  nonce TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  device_name TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_google_auth_pending_sessions_created_at
  ON google_auth_pending_sessions(created_at_ms);

ALTER TABLE content_idea_memory ADD COLUMN variant_kind TEXT;
ALTER TABLE content_idea_memory ADD COLUMN feedback_sentiment TEXT NOT NULL DEFAULT 'generated';
ALTER TABLE content_idea_memory ADD COLUMN feedback_notes TEXT;
ALTER TABLE google_auth_pending_sessions ADD COLUMN invite_code TEXT;

-- staging_fixture_calendar_events is intentionally untouched. It is a
-- staging-only fixture surface whose rows must survive release normalization.
