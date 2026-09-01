-- 306: Decision Center rewrite persistence foundation.
--
-- Earlier binaries created these Decision Center columns at runtime. Move
-- ownership into the migration ledger so a freshly migrated database and an
-- upgraded previous-binary database converge on the same schema. The
-- migration runner filters already-present ADD COLUMN statements during the
-- additive upgrade rehearsal.

ALTER TABLE notification_center_items ADD COLUMN snoozed_until TEXT;
ALTER TABLE notification_center_items ADD COLUMN action_result_json TEXT;
ALTER TABLE notification_intents ADD COLUMN decision_context_json TEXT;

-- Complete the rewrite's remaining durable contracts: immutable ranking
-- snapshots, first-class signal identity/provenance, scoped report completion
-- receipts, and leased replay-safe plan recomputes. All changes are additive
-- and predecessor-readable.

CREATE TABLE decision_center_rank_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  ranking_as_of TEXT NOT NULL,
  ranking_version INTEGER NOT NULL CHECK (ranking_version > 0),
  filter_fingerprint TEXT NOT NULL CHECK (length(filter_fingerprint) = 64),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  entry_count INTEGER NOT NULL CHECK (entry_count >= 0)
);

CREATE INDEX idx_decision_rank_snapshots_scope_latest
  ON decision_center_rank_snapshots (
    user_id,
    tenant_id,
    ranking_version,
    filter_fingerprint,
    ranking_as_of DESC
  );

CREATE INDEX idx_decision_rank_snapshots_expiry
  ON decision_center_rank_snapshots (expires_at);

CREATE TABLE decision_center_rank_snapshot_entries (
  snapshot_id TEXT NOT NULL,
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  decision_id TEXT NOT NULL,
  priority_tier TEXT NOT NULL
    CHECK (priority_tier IN ('critical', 'high', 'normal', 'low')),
  priority_score REAL NOT NULL CHECK (priority_score >= 0 AND priority_score <= 100),
  decision_created_at TEXT NOT NULL,
  projection_json TEXT,
  PRIMARY KEY (snapshot_id, ordinal),
  UNIQUE (snapshot_id, decision_id),
  FOREIGN KEY (snapshot_id)
    REFERENCES decision_center_rank_snapshots(snapshot_id) ON DELETE CASCADE
);

CREATE INDEX idx_decision_rank_snapshot_entries_scope
  ON decision_center_rank_snapshot_entries (
    snapshot_id,
    user_id,
    tenant_id,
    ordinal
  );

CREATE INDEX idx_decision_rank_snapshot_entries_decision_scope
  ON decision_center_rank_snapshot_entries (
    user_id,
    tenant_id,
    decision_id,
    snapshot_id
  );

ALTER TABLE agent_signals ADD COLUMN signal_identity TEXT;
ALTER TABLE agent_signals ADD COLUMN provenance_json TEXT;

UPDATE agent_signals
   SET signal_identity = 'legacy:' || id
 WHERE signal_identity IS NULL;

UPDATE agent_signals
   SET provenance_json = CASE
     WHEN json_valid(payload)
      AND json_type(payload, '$._signalProvenance') = 'object'
       THEN json_extract(payload, '$._signalProvenance')
     ELSE json_object(
       'producerVersion', 'legacy-unknown',
       'source', 'runtime',
       'observedAt', created_at
     )
   END
 WHERE provenance_json IS NULL;

CREATE INDEX idx_agent_signals_scoped_identity
  ON agent_signals (
    tenant_id,
    user_id,
    source_agent,
    signal_type,
    signal_identity,
    status
  );

-- Migration 304 deliberately preserves the predecessor report table and owns
-- the tenant-aware projection used by new code. Keep that rollback boundary:
-- Decision Center adds only its nullable dispatch identity to the scoped
-- projection and never changes the legacy user-only table.
ALTER TABLE report_documents_scoped ADD COLUMN dispatch_key TEXT;

CREATE INDEX idx_report_documents_scoped_dispatch
  ON report_documents_scoped (tenant_id, user_id, type, dispatch_key);

CREATE TABLE report_document_dispatch_receipts (
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  report_type TEXT NOT NULL,
  dispatch_key TEXT NOT NULL,
  report_document_id INTEGER NOT NULL CHECK (report_document_id > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, user_id, report_type, dispatch_key),
  UNIQUE (report_document_id)
);

CREATE INDEX idx_report_document_dispatch_receipts_report
  ON report_document_dispatch_receipts (report_document_id, tenant_id, user_id);

CREATE TABLE scheduled_report_completion_receipts (
  receipt_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  report_job TEXT NOT NULL
    CHECK (report_job IN ('morning_briefing', 'coach_briefing', 'end_of_day', 'weekly_review')),
  local_date TEXT NOT NULL
    CHECK (local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  attempts INTEGER NOT NULL CHECK (attempts > 0),
  completed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, tenant_id, report_job, local_date)
);

CREATE INDEX idx_scheduled_report_receipts_scope_date
  ON scheduled_report_completion_receipts (
    user_id,
    tenant_id,
    local_date DESC,
    report_job
  );

CREATE TABLE planning_recompute_receipts (
  receipt_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  idempotency_key_hash TEXT NOT NULL CHECK (length(idempotency_key_hash) = 64),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  lease_token TEXT,
  lease_expires_at TEXT,
  snapshot_id TEXT,
  response_json TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, tenant_id, idempotency_key_hash)
);

CREATE INDEX idx_planning_recompute_receipts_scope_created
  ON planning_recompute_receipts (user_id, tenant_id, created_at DESC);

INSERT OR IGNORE INTO scheduled_report_completion_receipts (
  receipt_id,
  job_id,
  user_id,
  tenant_id,
  report_job,
  local_date,
  attempts,
  completed_at,
  created_at
)
SELECT
  'scheduled-report-receipt:' || job_id,
  job_id,
  user_id,
  tenant_id,
  json_extract(payload_json, '$.reportJob'),
  json_extract(payload_json, '$.localDate'),
  attempts,
  completed_at,
  completed_at
FROM background_jobs
WHERE status = 'completed'
  AND completed_at IS NOT NULL
  AND user_id IS NOT NULL
  AND user_id > 0
  AND tenant_id > 0
  AND job_type LIKE 'scheduled_report_delivery:%'
  AND json_valid(payload_json)
  AND json_extract(payload_json, '$.reportJob') IN (
    'morning_briefing',
    'coach_briefing',
    'end_of_day',
    'weekly_review'
  )
  AND json_extract(payload_json, '$.localDate') GLOB
    '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]';
