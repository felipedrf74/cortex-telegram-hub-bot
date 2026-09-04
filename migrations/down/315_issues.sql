DROP INDEX IF EXISTS idx_error_log_issue;
DROP INDEX IF EXISTS idx_error_log_req;
DROP INDEX IF EXISTS idx_client_errors_issue;
DROP INDEX IF EXISTS idx_client_errors_req;
ALTER TABLE error_log DROP COLUMN issue_id;
ALTER TABLE error_log DROP COLUMN req_id;
ALTER TABLE client_errors DROP COLUMN issue_id;
ALTER TABLE client_errors DROP COLUMN req_id;
DROP TABLE IF EXISTS issues;
