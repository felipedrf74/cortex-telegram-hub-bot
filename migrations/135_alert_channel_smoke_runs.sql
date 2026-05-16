-- Phase 11 batch 56 (2026-05-16): persist alert-channel weekly smoke-run
-- results so trend-over-weeks queries are possible (Phase 10 carry-over #6).
--
-- Each row represents ONE channel result from ONE smoke-run invocation.
-- The `run_id` column groups channels from the same invocation so the
-- report can be reconstructed; the natural key is (run_id, channel_id).

CREATE TABLE IF NOT EXISTS chat_alert_channel_smoke_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'skipped', 'failed', 'dry_run')),
  elapsed_ms INTEGER NOT NULL,
  error_message TEXT,
  generated_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(run_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_alert_channel_smoke_runs_channel_status
ON chat_alert_channel_smoke_runs(channel_id, status, generated_at);

CREATE INDEX IF NOT EXISTS idx_chat_alert_channel_smoke_runs_generated_at
ON chat_alert_channel_smoke_runs(generated_at DESC);
