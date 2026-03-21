-- Missing indexes for frequently queried columns
CREATE INDEX IF NOT EXISTS idx_reminders_remind_at ON reminders(remind_at);
CREATE INDEX IF NOT EXISTS idx_conversations_domain ON conversations(domain, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_references_created ON content_references(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_usage_ts ON api_usage(ts);
CREATE INDEX IF NOT EXISTS idx_job_history_ts ON job_history(ts);
