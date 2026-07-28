-- 264: User reports of problematic AI output (App Review guideline 1.2).
--
-- Backs POST /api/v1/ai-reports. Every row is a user-submitted report about a
-- specific assistant message: what was wrong with it, plus the bounded excerpt
-- the client displayed. There is no moderation state machine here — this table
-- is the durable inbox the operator reviews.
--
-- `user_id` is required and indexed so the row participates in the existing
-- account-deletion cascade and GDPR export, both of which discover tables by
-- ownership column (see src/services/user-data-export.ts).

CREATE TABLE IF NOT EXISTS ai_output_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id TEXT NOT NULL UNIQUE,
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  message_id TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 200),
  conversation_id TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('harmful', 'inaccurate', 'offensive', 'other')),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 8000),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_output_reports_user
  ON ai_output_reports(user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_ai_output_reports_triage
  ON ai_output_reports(reason, created_at);
