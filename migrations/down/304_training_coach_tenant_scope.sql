-- Reverse migration 304.
--
-- The legacy coach_states table can represent only identity scope. Preserve
-- those rows and deliberately drop delegated-tenant rows rather than guessing
-- which tenant should own the single user_id slot.

-- Back-port only identity-scoped reports. Delegated tenant data remains
-- deliberately unrepresentable in the predecessor table.
INSERT OR IGNORE INTO report_documents (
  id, user_id, type, title, summary, document_json,
  source_job, status, read_at, created_at
)
SELECT
  id, user_id, type, title, summary, document_json,
  source_job, status, read_at, created_at
FROM report_documents_scoped
WHERE tenant_id = user_id;

DROP INDEX IF EXISTS idx_reports_tenant_user_status;
DROP INDEX IF EXISTS idx_reports_tenant_user_type;
DROP TABLE report_documents_scoped;

INSERT INTO coach_states (
  user_id,
  recommendations_json,
  briefing_summary,
  created_at_ms,
  expires_at_ms,
  updated_at
)
SELECT
  user_id,
  recommendations_json,
  briefing_summary,
  created_at_ms,
  expires_at_ms,
  updated_at
FROM coach_states_scoped
WHERE tenant_id = user_id
ON CONFLICT(user_id) DO UPDATE SET
  recommendations_json = excluded.recommendations_json,
  briefing_summary = excluded.briefing_summary,
  created_at_ms = excluded.created_at_ms,
  expires_at_ms = excluded.expires_at_ms,
  updated_at = excluded.updated_at;

DROP INDEX IF EXISTS idx_coach_states_scoped_user_tenant;
DROP INDEX IF EXISTS idx_coach_states_scoped_expires_at;
DROP TABLE coach_states_scoped;

-- The legacy key cannot represent multiple tenant claims for one user/day.
-- Preserve only unambiguous identity-scope claims on rollback.
INSERT OR IGNORE INTO report_schedule_ledger (
  user_id,
  tenant_id,
  job_type,
  fired_for_local_date,
  fired_at
)
SELECT
  user_id,
  tenant_id,
  job_type,
  fired_for_local_date,
  fired_at
FROM report_schedule_ledger_scoped
WHERE tenant_id = user_id;

DROP INDEX IF EXISTS idx_report_schedule_ledger_scoped_user_tenant;
DROP INDEX IF EXISTS idx_report_schedule_ledger_scoped_fired_at;
DROP TABLE report_schedule_ledger_scoped;
