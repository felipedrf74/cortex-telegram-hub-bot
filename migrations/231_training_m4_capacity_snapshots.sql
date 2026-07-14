-- 231: Materialized authoritative capacity snapshots for Training M4.
--
-- Snapshots bind user-declared weekly availability to a complete, successful
-- read of every connected calendar provider for one exact planning horizon.
-- Runtime remains dormant unless the existing scoped Training M4 flags are
-- enabled. No calendar provider writes are performed by this schema.

CREATE TABLE IF NOT EXISTS training_m4_capacity_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  schema_version TEXT NOT NULL CHECK (schema_version = 'training-m4-capacity-snapshot.v1'),
  context_version TEXT NOT NULL CHECK (length(context_version) BETWEEN 16 AND 200),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  profile_source_version TEXT NOT NULL CHECK (length(profile_source_version) BETWEEN 16 AND 200),
  calendar_event_set_hash TEXT NOT NULL CHECK (length(calendar_event_set_hash) = 64),
  provider_sources_json TEXT NOT NULL CHECK (json_valid(provider_sources_json)),
  provider_status TEXT NOT NULL CHECK (provider_status = 'ready'),
  plan_start_date TEXT NOT NULL CHECK (length(plan_start_date) = 10),
  plan_end_date TEXT NOT NULL CHECK (length(plan_end_date) = 10),
  horizon_weeks INTEGER NOT NULL CHECK (horizon_weeks BETWEEN 1 AND 52),
  range_start_at TEXT NOT NULL,
  range_end_at TEXT NOT NULL,
  profile_windows_json TEXT NOT NULL CHECK (json_valid(profile_windows_json)),
  capacity_windows_json TEXT NOT NULL CHECK (json_valid(capacity_windows_json)),
  conflict_count INTEGER NOT NULL CHECK (conflict_count >= 0),
  observed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (tenant_id = user_id),
  UNIQUE (tenant_id, user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_training_m4_capacity_scope_freshness
  ON training_m4_capacity_snapshots(tenant_id, user_id, observed_at DESC, expires_at DESC);

-- Short-lived, transaction-local authority for bounded retention. The delete
-- trigger below still rejects fresh snapshots and preserves at least one copy
-- of every revision-referenced context, so this cannot become a general
-- mutation bypass. Duplicate snapshots for the same referenced content hash
-- remain eligible for bounded retention.
CREATE TABLE IF NOT EXISTS training_m4_capacity_prune_authorizations (
  authorization_id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  prune_before_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (tenant_id = user_id)
);

CREATE TRIGGER IF NOT EXISTS trg_training_m4_capacity_snapshots_immutable_update
BEFORE UPDATE ON training_m4_capacity_snapshots
BEGIN
  SELECT RAISE(ABORT, 'training M4 capacity snapshots are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_training_m4_capacity_snapshots_immutable_delete
BEFORE DELETE ON training_m4_capacity_snapshots
WHEN NOT EXISTS (
  SELECT 1 FROM training_revision_erasure_authorizations authorization
   WHERE authorization.subject_user_id = OLD.user_id
     AND datetime(authorization.expires_at) >= datetime('now')
)
AND NOT (
  EXISTS (
    SELECT 1 FROM training_m4_capacity_prune_authorizations authorization
     WHERE authorization.tenant_id = OLD.tenant_id
       AND authorization.user_id = OLD.user_id
       AND datetime(OLD.expires_at) < datetime(authorization.prune_before_at)
       AND datetime(authorization.expires_at) >= datetime('now')
  )
  AND (
    NOT EXISTS (
      SELECT 1 FROM training_plan_revisions revision
       WHERE revision.tenant_id = OLD.tenant_id
         AND revision.user_id = OLD.user_id
         AND json_extract(revision.revision_document_json, '$.capacityContextVersion') = OLD.context_version
    )
    OR EXISTS (
      SELECT 1 FROM training_m4_capacity_snapshots replacement
       WHERE replacement.tenant_id = OLD.tenant_id
         AND replacement.user_id = OLD.user_id
         AND replacement.context_version = OLD.context_version
         AND replacement.snapshot_id <> OLD.snapshot_id
         AND (
           datetime(replacement.observed_at) > datetime(OLD.observed_at)
           OR (
             datetime(replacement.observed_at) = datetime(OLD.observed_at)
             AND replacement.rowid > OLD.rowid
           )
         )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'training M4 capacity snapshots are immutable');
END;
