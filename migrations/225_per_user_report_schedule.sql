-- 225: Per-user schedule times for the user-facing report crons.
-- The morning briefing, coach briefing, end-of-day summary, and weekly
-- review previously fired from single global crons at one server-timezone
-- moment for every user. The scheduler now runs a windowed dispatcher per
-- job (every 5 minutes) that fires each user at their preferred time in
-- their own timezone (src/services/report-schedule-dispatcher.ts).
--
-- All five columns are NULLABLE and NULL means "use the global default"
-- (TODO_DIGEST_TIME, GARMIN_COACH_TIME, 21:00, Friday 17:00) so behavior is
-- unchanged until a user explicitly picks a time. These are deliberately
-- separate from daily_digest_time / weekly_review_day / weekly_review_time,
-- which belong to the notification-digest release subsystem.
ALTER TABLE notification_profiles ADD COLUMN morning_briefing_time TEXT;
ALTER TABLE notification_profiles ADD COLUMN coach_briefing_time TEXT;
ALTER TABLE notification_profiles ADD COLUMN end_of_day_time TEXT;
-- Cron day-of-week convention (0=Sunday..6=Saturday), matching weekly_review_day.
ALTER TABLE notification_profiles ADD COLUMN weekly_review_report_day INTEGER;
ALTER TABLE notification_profiles ADD COLUMN weekly_review_report_time TEXT;

-- Claim ledger: one row per user+job+user-local-date, inserted with
-- INSERT OR IGNORE before generation. Guarantees at-most-once dispatch per
-- day (including across restarts) and powers the 2h catch-up window.
CREATE TABLE IF NOT EXISTS report_schedule_ledger (
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  job_type TEXT NOT NULL,
  fired_for_local_date TEXT NOT NULL,
  fired_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, job_type, fired_for_local_date)
);
CREATE INDEX IF NOT EXISTS idx_report_schedule_ledger_fired_at
  ON report_schedule_ledger(fired_at);
