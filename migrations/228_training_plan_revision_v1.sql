-- 228: Training plan revision v1 — additive dormant foundation.
--
-- This migration does not activate, reschedule, cancel or mutate any existing
-- Training plan. Runtime writes remain gated by TRAINING_PLAN_REVISION_V1_MODE.
-- The existing event_outbox remains the only domain-event outbox.

CREATE TABLE IF NOT EXISTS training_revision_erasure_authorizations (
  erasure_id TEXT PRIMARY KEY,
  subject_user_id INTEGER NOT NULL CHECK (subject_user_id > 0),
  reason TEXT NOT NULL CHECK (reason IN ('ACCOUNT_DELETION', 'LEGAL_ERASURE')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS training_profile_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  snapshot_sequence INTEGER NOT NULL CHECK (snapshot_sequence > 0),
  schema_version TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  encrypted_snapshot_body TEXT NOT NULL,
  snapshot_body_key_version TEXT NOT NULL,
  display_factor_index_json TEXT NOT NULL CHECK (json_valid(display_factor_index_json)),
  normalized_goals_json TEXT NOT NULL CHECK (json_valid(normalized_goals_json)),
  normalized_constraints_json TEXT NOT NULL CHECK (json_valid(normalized_constraints_json)),
  factor_evidence_json TEXT NOT NULL CHECK (json_valid(factor_evidence_json)),
  source_versions_json TEXT NOT NULL CHECK (json_valid(source_versions_json)),
  consent_context_json TEXT NOT NULL CHECK (json_valid(consent_context_json)),
  missing_inputs_json TEXT NOT NULL CHECK (json_valid(missing_inputs_json)),
  observed_at TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, user_id, snapshot_sequence),
  UNIQUE (tenant_id, user_id, snapshot_id),
  UNIQUE (tenant_id, user_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_training_profile_snapshots_scope_created
  ON training_profile_snapshots(tenant_id, user_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_training_profile_snapshots_immutable_update
BEFORE UPDATE ON training_profile_snapshots
BEGIN
  SELECT RAISE(ABORT, 'training profile snapshots are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_training_profile_snapshots_immutable_delete
BEFORE DELETE ON training_profile_snapshots
WHEN NOT EXISTS (
  SELECT 1 FROM training_revision_erasure_authorizations authorization
   WHERE authorization.subject_user_id = OLD.user_id
     AND datetime(authorization.expires_at) >= datetime('now')
)
BEGIN
  SELECT RAISE(ABORT, 'training profile snapshots are immutable');
END;

CREATE TABLE IF NOT EXISTS training_plan_families (
  family_id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  family_key TEXT NOT NULL,
  plan_mode TEXT NOT NULL CHECK (plan_mode IN (
    'event_based', 'continuous', 'maintenance', 'return_to_training'
  )),
  discipline TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('GENERATED', 'LEGACY_BACKFILL')),
  legacy_plan_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, user_id, family_key),
  UNIQUE (tenant_id, user_id, family_id)
);

CREATE INDEX IF NOT EXISTS idx_training_plan_families_scope_created
  ON training_plan_families(tenant_id, user_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_training_plan_families_identity_immutable
BEFORE UPDATE ON training_plan_families
WHEN NEW.family_id IS NOT OLD.family_id
  OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.user_id IS NOT OLD.user_id
  OR NEW.family_key IS NOT OLD.family_key
  OR NEW.plan_mode IS NOT OLD.plan_mode
  OR NEW.discipline IS NOT OLD.discipline
  OR NEW.origin IS NOT OLD.origin
  OR NEW.legacy_plan_id IS NOT OLD.legacy_plan_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'training plan family identity is immutable');
END;

CREATE TABLE IF NOT EXISTS training_plan_revisions (
  revision_id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  family_id TEXT NOT NULL,
  revision_sequence INTEGER NOT NULL CHECK (revision_sequence > 0),
  parent_revision_id TEXT,
  profile_snapshot_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('GENERATED', 'LEGACY_BACKFILL')),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN (
    'CANDIDATE', 'PENDING_REVIEW', 'ACTIVE', 'SUPERSEDED', 'EXPIRED', 'LEGACY_ACTIVE'
  )),
  approval_state TEXT NOT NULL DEFAULT 'UNREVIEWED' CHECK (approval_state IN (
    'UNREVIEWED', 'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'
  )),
  decision_id TEXT,
  creation_context_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  catalog_version TEXT NOT NULL,
  catalog_source_hash TEXT NOT NULL CHECK (length(catalog_source_hash) = 64),
  capability_registry_version TEXT NOT NULL,
  document_schema_version TEXT NOT NULL,
  revision_document_json TEXT NOT NULL CHECK (json_valid(revision_document_json)),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  quality_report_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(quality_report_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  review_requested_at TEXT,
  activated_at TEXT,
  superseded_at TEXT,
  expired_at TEXT,
  UNIQUE (tenant_id, user_id, family_id, revision_sequence),
  UNIQUE (tenant_id, user_id, family_id, revision_id),
  UNIQUE (tenant_id, user_id, revision_id),
  FOREIGN KEY (tenant_id, user_id, family_id)
    REFERENCES training_plan_families(tenant_id, user_id, family_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id, profile_snapshot_id)
    REFERENCES training_profile_snapshots(tenant_id, user_id, snapshot_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id, parent_revision_id)
    REFERENCES training_plan_revisions(tenant_id, user_id, revision_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_training_plan_revisions_scope_state
  ON training_plan_revisions(tenant_id, user_id, lifecycle_state, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_training_plan_revisions_family_sequence
  ON training_plan_revisions(tenant_id, user_id, family_id, revision_sequence DESC);

CREATE INDEX IF NOT EXISTS idx_training_plan_revisions_family_content_context
  ON training_plan_revisions(
    tenant_id, user_id, family_id, content_hash, creation_context_version,
    revision_sequence DESC
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_training_plan_revisions_decision
  ON training_plan_revisions(tenant_id, user_id, decision_id)
  WHERE decision_id IS NOT NULL;

-- Mutable pointer to the latest explicit profile/context submitted for a plan
-- family. Decisions compare against this authoritative pointer, not against
-- the immutable context stored on the candidate being reviewed.
CREATE TABLE IF NOT EXISTS training_plan_current_contexts (
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  family_id TEXT NOT NULL,
  current_revision_id TEXT NOT NULL,
  current_profile_snapshot_id TEXT NOT NULL,
  current_context_version TEXT NOT NULL,
  base_context_version TEXT NOT NULL,
  profile_source_version TEXT NOT NULL CHECK (length(profile_source_version) > 8),
  calendar_source_version TEXT NOT NULL CHECK (length(calendar_source_version) > 8),
  conflict_source_version TEXT NOT NULL CHECK (length(conflict_source_version) > 8),
  pointer_version INTEGER NOT NULL DEFAULT 1 CHECK (pointer_version > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, user_id, family_id),
  FOREIGN KEY (tenant_id, user_id, family_id)
    REFERENCES training_plan_families(tenant_id, user_id, family_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id, family_id, current_revision_id)
    REFERENCES training_plan_revisions(tenant_id, user_id, family_id, revision_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id, current_profile_snapshot_id)
    REFERENCES training_profile_snapshots(tenant_id, user_id, snapshot_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_training_plan_current_contexts_scope
  ON training_plan_current_contexts(tenant_id, user_id, updated_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_training_plan_current_contexts_graph_insert
BEFORE INSERT ON training_plan_current_contexts
WHEN NOT EXISTS (
  SELECT 1 FROM training_plan_revisions revisions
   WHERE revisions.tenant_id = NEW.tenant_id
     AND revisions.user_id = NEW.user_id
     AND revisions.family_id = NEW.family_id
     AND revisions.revision_id = NEW.current_revision_id
     AND revisions.profile_snapshot_id = NEW.current_profile_snapshot_id
     AND revisions.creation_context_version = NEW.current_context_version
)
BEGIN
  SELECT RAISE(ABORT, 'training current context graph is inconsistent');
END;

CREATE TRIGGER IF NOT EXISTS trg_training_plan_current_contexts_graph_update
BEFORE UPDATE ON training_plan_current_contexts
WHEN NOT EXISTS (
  SELECT 1 FROM training_plan_revisions revisions
   WHERE revisions.tenant_id = NEW.tenant_id
     AND revisions.user_id = NEW.user_id
     AND revisions.family_id = NEW.family_id
     AND revisions.revision_id = NEW.current_revision_id
     AND revisions.profile_snapshot_id = NEW.current_profile_snapshot_id
     AND revisions.creation_context_version = NEW.current_context_version
)
BEGIN
  SELECT RAISE(ABORT, 'training current context graph is inconsistent');
END;

CREATE TRIGGER IF NOT EXISTS trg_training_plan_revisions_content_immutable
BEFORE UPDATE ON training_plan_revisions
WHEN NEW.revision_id IS NOT OLD.revision_id
  OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.user_id IS NOT OLD.user_id
  OR NEW.family_id IS NOT OLD.family_id
  OR NEW.revision_sequence IS NOT OLD.revision_sequence
  OR NEW.parent_revision_id IS NOT OLD.parent_revision_id
  OR NEW.profile_snapshot_id IS NOT OLD.profile_snapshot_id
  OR NEW.origin IS NOT OLD.origin
  OR NEW.creation_context_version IS NOT OLD.creation_context_version
  OR NEW.policy_version IS NOT OLD.policy_version
  OR NEW.catalog_version IS NOT OLD.catalog_version
  OR NEW.catalog_source_hash IS NOT OLD.catalog_source_hash
  OR NEW.capability_registry_version IS NOT OLD.capability_registry_version
  OR NEW.document_schema_version IS NOT OLD.document_schema_version
  OR NEW.revision_document_json IS NOT OLD.revision_document_json
  OR NEW.content_hash IS NOT OLD.content_hash
  OR NEW.quality_report_json IS NOT OLD.quality_report_json
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'training plan revision content is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_training_plan_revisions_no_delete
BEFORE DELETE ON training_plan_revisions
WHEN NOT EXISTS (
  SELECT 1 FROM training_revision_erasure_authorizations authorization
   WHERE authorization.subject_user_id = OLD.user_id
     AND datetime(authorization.expires_at) >= datetime('now')
)
BEGIN
  SELECT RAISE(ABORT, 'training plan revisions are immutable records');
END;

CREATE TRIGGER IF NOT EXISTS trg_training_plan_revisions_decision_binding_immutable
BEFORE UPDATE ON training_plan_revisions
WHEN OLD.decision_id IS NOT NULL AND NEW.decision_id IS NOT OLD.decision_id
BEGIN
  SELECT RAISE(ABORT, 'training plan revision decision binding is immutable');
END;

CREATE TABLE IF NOT EXISTS training_plan_revision_approvals (
  approval_id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  family_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  decision_record_version INTEGER NOT NULL CHECK (decision_record_version > 0),
  action_execution_id TEXT NOT NULL,
  approved_content_hash TEXT NOT NULL CHECK (length(approved_content_hash) = 64),
  approved_context_version TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'admin', 'system_migration')),
  approval_source TEXT NOT NULL CHECK (approval_source IN (
    'DECISION_CENTER', 'LEGACY_EXISTING_COMMITMENT'
  )),
  approved_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, user_id, revision_id),
  UNIQUE (tenant_id, user_id, decision_id, action_execution_id),
  FOREIGN KEY (tenant_id, user_id, family_id, revision_id)
    REFERENCES training_plan_revisions(tenant_id, user_id, family_id, revision_id) ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS trg_training_plan_revision_approvals_immutable_update
BEFORE UPDATE ON training_plan_revision_approvals
BEGIN
  SELECT RAISE(ABORT, 'training plan revision approvals are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_training_plan_revision_approvals_immutable_delete
BEFORE DELETE ON training_plan_revision_approvals
WHEN NOT EXISTS (
  SELECT 1 FROM training_revision_erasure_authorizations authorization
   WHERE authorization.subject_user_id = OLD.user_id
     AND datetime(authorization.expires_at) >= datetime('now')
)
BEGIN
  SELECT RAISE(ABORT, 'training plan revision approvals are immutable');
END;

CREATE TABLE IF NOT EXISTS training_active_plan_references (
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  family_id TEXT NOT NULL,
  active_revision_id TEXT NOT NULL,
  projection_plan_id INTEGER,
  pointer_version INTEGER NOT NULL DEFAULT 1 CHECK (pointer_version > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, user_id, family_id),
  UNIQUE (tenant_id, user_id, active_revision_id),
  FOREIGN KEY (tenant_id, user_id, family_id)
    REFERENCES training_plan_families(tenant_id, user_id, family_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id, family_id, active_revision_id)
    REFERENCES training_plan_revisions(tenant_id, user_id, family_id, revision_id) ON DELETE CASCADE,
  FOREIGN KEY (projection_plan_id)
    REFERENCES fitness_training_plans(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_training_active_plan_references_projection
  ON training_active_plan_references(tenant_id, user_id, projection_plan_id)
  WHERE projection_plan_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS training_plan_revision_operations (
  operation_id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  operation_type TEXT NOT NULL CHECK (operation_type IN (
    'CREATE_CANDIDATE', 'EDIT_PREVIEW', 'BIND_DECISION'
  )),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  status TEXT NOT NULL CHECK (status IN (
    'IN_PROGRESS', 'SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_TERMINAL'
  )),
  result_family_id TEXT,
  result_revision_id TEXT,
  result_decision_id TEXT,
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  lease_owner TEXT,
  lease_expires_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  last_error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  UNIQUE (tenant_id, user_id, operation_type, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_training_plan_revision_operations_scope_status
  ON training_plan_revision_operations(tenant_id, user_id, status, created_at DESC);

ALTER TABLE fitness_training_plans ADD COLUMN source_revision_id TEXT;
ALTER TABLE training_weeks ADD COLUMN source_revision_id TEXT;
ALTER TABLE training_weeks ADD COLUMN revision_week_key TEXT;
ALTER TABLE training_sessions ADD COLUMN source_revision_id TEXT;
ALTER TABLE training_sessions ADD COLUMN revision_session_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_fitness_training_plans_source_revision
  ON fitness_training_plans(source_revision_id)
  WHERE source_revision_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_training_weeks_revision_key
  ON training_weeks(source_revision_id, revision_week_key)
  WHERE source_revision_id IS NOT NULL AND revision_week_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_training_sessions_revision_key
  ON training_sessions(source_revision_id, revision_session_key)
  WHERE source_revision_id IS NOT NULL AND revision_session_key IS NOT NULL;
