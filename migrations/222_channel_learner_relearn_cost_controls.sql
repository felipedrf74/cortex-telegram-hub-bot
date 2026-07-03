-- 222: Channel learner re-learn cost controls (2026-07-03 audit).
-- The weekly channel_relearn cron re-analyzed EVERY active channel each
-- cycle (multiple Gemini/Anthropic calls per channel) without checking
-- whether the channel had published anything new, and auto-retried failed
-- channels every cycle after 12h forever.
--
-- analysis_fingerprint: deterministic fingerprint of the video set used by
--   the last successful analysis (format 'v1:<count>:<sorted video ids>').
--   In the re-learn path, if the freshly fetched video list produces the
--   same fingerprint, extraction + synthesis are skipped for that channel.
--   NULL means "never fingerprinted" and always analyzes (backward compat).
-- last_checked_at: bumped whenever the learner verified the channel's video
--   list (skip or full analysis), so skips are observable independently of
--   last_analyzed_at.
-- consecutive_failure_count: incremented on each failed analysis, reset to 0
--   on success (including a fingerprint skip). At >= 3 the 12h auto-retry is
--   backed off to at most one retry per 7 days.
ALTER TABLE content_ref_channels ADD COLUMN analysis_fingerprint TEXT;
ALTER TABLE content_ref_channels ADD COLUMN last_checked_at TEXT;
ALTER TABLE content_ref_channels ADD COLUMN consecutive_failure_count INTEGER NOT NULL DEFAULT 0;

-- Rollback:
-- ALTER TABLE content_ref_channels DROP COLUMN analysis_fingerprint;
-- ALTER TABLE content_ref_channels DROP COLUMN last_checked_at;
-- ALTER TABLE content_ref_channels DROP COLUMN consecutive_failure_count;
