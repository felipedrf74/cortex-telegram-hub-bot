-- Missing indexes for frequently queried columns
CREATE INDEX IF NOT EXISTS idx_reminders_remind_at ON reminders(remind_at);
CREATE INDEX IF NOT EXISTS idx_conversations_domain ON conversations(domain, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_ref_channels_status ON content_ref_channels(status);
CREATE INDEX IF NOT EXISTS idx_api_usage_ts ON api_usage(ts);
CREATE INDEX IF NOT EXISTS idx_job_history_ts ON job_history(ts);
