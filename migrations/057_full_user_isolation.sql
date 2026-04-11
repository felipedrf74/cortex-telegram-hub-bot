-- Migration 057: Complete multi-user data isolation.
-- Adds user_id to ALL remaining user-facing tables that were created
-- before multi-user support (M029). Existing data defaults to user_id=0.
--
-- CRITICAL TABLES (user data leakage risk):

-- ── Invoices & Finance ────────────────────────────────────────────
ALTER TABLE invoice_filings ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_invoice_filings_user ON invoice_filings(user_id);

ALTER TABLE invoice_vendors ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_invoice_vendors_user ON invoice_vendors(user_id);

ALTER TABLE invoice_queue ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_invoice_queue_user ON invoice_queue(user_id);

-- ── Content Research ──────────────────────────────────────────────
ALTER TABLE video_transcripts ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_video_transcripts_user ON video_transcripts(user_id);

ALTER TABLE video_studies ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_video_studies_user ON video_studies(user_id);

ALTER TABLE content_patterns ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_content_patterns_user ON content_patterns(user_id);

-- ── Content Topic Feedback (if exists) ────────────────────────────
-- This table may not exist on all installations
ALTER TABLE content_topic_feedback ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_content_topic_feedback_user ON content_topic_feedback(user_id);

-- ── Content Research Briefs ───────────────────────────────────────
ALTER TABLE content_research_briefs ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_content_research_briefs_user ON content_research_briefs(user_id);

-- ── Webhooks ──────────────────────────────────────────────────────
ALTER TABLE webhook_subscriptions ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_user ON webhook_subscriptions(user_id);

ALTER TABLE webhook_events ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_webhook_events_user ON webhook_events(user_id);
