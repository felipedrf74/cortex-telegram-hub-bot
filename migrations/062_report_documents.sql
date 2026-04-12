-- Migration 062: Report Documents — durable structured reports
--
-- Reports (morning briefing, evening summary, weekly review, coach briefing)
-- were previously fire-and-forget via Telegram + APNs. This table stores
-- them as durable structured documents that:
--   1. iOS can fetch on launch (catch up on missed reports)
--   2. Portal can inspect for operational visibility
--   3. Support read/unread lifecycle for the iOS inbox
--   4. Preserve the full structured data alongside rendered text
--
-- The document_json field holds the structured report payload — the exact
-- data the iOS app renders natively. The summary field holds a short
-- human-readable preview for notification bodies and list views.

CREATE TABLE IF NOT EXISTS report_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    document_json JSON NOT NULL,
    source_job TEXT,
    status TEXT NOT NULL DEFAULT 'unread',
    read_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reports_user_type
    ON report_documents(user_id, type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reports_status
    ON report_documents(user_id, status, created_at DESC);
