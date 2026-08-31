-- 304: Durable tenant scope for coach reports and actionable coach state.
--
-- This is an expand/backfill migration. It never rebuilds or removes a table
-- used by the predecessor runtime, so ordinary protected-main CD retains a
-- safe code rollback after the database advances.

-- The predecessor report table remains intact because its readers are keyed by
-- user_id only. New tenant-aware code uses an isolated projection so a runtime
-- rollback cannot expose delegated-tenant reports through the old reader.
CREATE TABLE IF NOT EXISTS report_documents_scoped (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  document_json JSON NOT NULL,
  source_job TEXT,
  status TEXT NOT NULL DEFAULT 'unread',
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO report_documents_scoped (
  id, tenant_id, user_id, type, title, summary, document_json,
  source_job, status, read_at, created_at
)
SELECT
  id, user_id, user_id, type, title, summary, document_json,
  source_job, status, read_at, created_at
FROM report_documents
WHERE typeof(user_id) = 'integer' AND user_id > 0;

CREATE INDEX IF NOT EXISTS idx_reports_tenant_user_type
  ON report_documents_scoped(tenant_id, user_id, type, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_reports_tenant_user_status
  ON report_documents_scoped(tenant_id, user_id, status, created_at DESC, id DESC);

-- The predecessor `coach_states` table remains intact for rollback. New code
-- uses this composite-key store and identity-backfills only unambiguous rows.
CREATE TABLE IF NOT EXISTS coach_states_scoped (
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  recommendations_json TEXT NOT NULL,
  briefing_summary TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, user_id)
);

INSERT OR IGNORE INTO coach_states_scoped (
  tenant_id,
  user_id,
  recommendations_json,
  briefing_summary,
  created_at_ms,
  expires_at_ms,
  updated_at
)
SELECT
  user_id,
  user_id,
  recommendations_json,
  briefing_summary,
  created_at_ms,
  expires_at_ms,
  updated_at
FROM coach_states
WHERE typeof(user_id) = 'integer'
  AND user_id > 0;

CREATE INDEX IF NOT EXISTS idx_coach_states_scoped_expires_at
  ON coach_states_scoped(expires_at_ms);

CREATE INDEX IF NOT EXISTS idx_coach_states_scoped_user_tenant
  ON coach_states_scoped(user_id, tenant_id);

-- Preserve the predecessor claim ledger and project its unambiguous claims
-- into the composite-key store used by the tenant-aware scheduler.
CREATE TABLE IF NOT EXISTS report_schedule_ledger_scoped (
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  job_type TEXT NOT NULL,
  fired_for_local_date TEXT NOT NULL,
  fired_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, user_id, job_type, fired_for_local_date)
);

INSERT OR IGNORE INTO report_schedule_ledger_scoped (
  tenant_id,
  user_id,
  job_type,
  fired_for_local_date,
  fired_at
)
SELECT
  tenant_id,
  user_id,
  job_type,
  fired_for_local_date,
  fired_at
FROM report_schedule_ledger
WHERE typeof(tenant_id) = 'integer'
  AND tenant_id > 0
  AND typeof(user_id) = 'integer'
  AND user_id > 0;

CREATE INDEX IF NOT EXISTS idx_report_schedule_ledger_scoped_fired_at
  ON report_schedule_ledger_scoped(fired_at);

CREATE INDEX IF NOT EXISTS idx_report_schedule_ledger_scoped_user_tenant
  ON report_schedule_ledger_scoped(user_id, tenant_id, fired_at DESC);
