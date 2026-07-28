-- Roll back the AI-output report inbox introduced by migration 264. The
-- separate audit_trail rows written for each report remain immutable as
-- security evidence under the repository retention policy.

DROP INDEX IF EXISTS idx_ai_output_reports_triage;
DROP INDEX IF EXISTS idx_ai_output_reports_user;
DROP TABLE IF EXISTS ai_output_reports;
