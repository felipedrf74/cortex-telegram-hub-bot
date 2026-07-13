-- 230: Training adaptation proposals v1 — additive, dormant, and immutable.
--
-- This migration does not alter an active plan. It records explicit busy-day,
-- tired-day, and substitution proposals that can create immutable child plan
-- revisions. Activation remains separately Decision-approved and CAS guarded.

CREATE TABLE IF NOT EXISTS training_adaptation_previews (
  adaptation_id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  family_id TEXT NOT NULL,
  source_revision_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('BUSY_DAY', 'TIRED_DAY', 'SUBSTITUTION', 'REFLOW')),
  scope TEXT NOT NULL CHECK (scope IN ('SESSION', 'WEEK', 'PHASE', 'FULL_PLAN')),
  target_json TEXT NOT NULL CHECK (json_valid(target_json)),
  explicit_input_json TEXT NOT NULL CHECK (json_valid(explicit_input_json)),
  options_json TEXT NOT NULL CHECK (json_valid(options_json)),
  preview_hash TEXT NOT NULL CHECK (length(preview_hash) = 64),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  expected_source_content_hash TEXT NOT NULL CHECK (length(expected_source_content_hash) = 64),
  expected_context_version TEXT NOT NULL,
  expected_active_pointer_version INTEGER NOT NULL CHECK (expected_active_pointer_version > 0),
  policy_version TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id, user_id, family_id)
    REFERENCES training_plan_families(tenant_id, user_id, family_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id, family_id, source_revision_id)
    REFERENCES training_plan_revisions(tenant_id, user_id, family_id, revision_id) ON DELETE CASCADE,
  UNIQUE (tenant_id, user_id, event_id),
  UNIQUE (tenant_id, user_id, adaptation_id)
);

CREATE INDEX IF NOT EXISTS idx_training_adaptation_previews_scope_expiry
  ON training_adaptation_previews(tenant_id, user_id, expires_at, created_at DESC);

CREATE TABLE IF NOT EXISTS training_adaptation_proposals (
  proposal_id TEXT PRIMARY KEY,
  adaptation_id TEXT NOT NULL,
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  family_id TEXT NOT NULL,
  source_revision_id TEXT NOT NULL,
  proposed_revision_id TEXT,
  decision_id TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('SESSION', 'WEEK', 'PHASE', 'FULL_PLAN')),
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('BUSY_DAY', 'TIRED_DAY', 'SUBSTITUTION', 'REFLOW')),
  option_kind TEXT NOT NULL,
  selected_option_id TEXT NOT NULL,
  option_hash TEXT NOT NULL CHECK (length(option_hash) = 64),
  material_fingerprint TEXT NOT NULL CHECK (length(material_fingerprint) = 64),
  explicit_input_json TEXT NOT NULL CHECK (json_valid(explicit_input_json)),
  current_state_json TEXT NOT NULL CHECK (json_valid(current_state_json)),
  proposed_state_json TEXT NOT NULL CHECK (json_valid(proposed_state_json)),
  differences_json TEXT NOT NULL CHECK (json_valid(differences_json)),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  rationale TEXT NOT NULL,
  expected_benefit TEXT NOT NULL,
  possible_downside TEXT NOT NULL,
  reversibility TEXT NOT NULL,
  future_session_effect TEXT NOT NULL,
  approval_required INTEGER NOT NULL DEFAULT 1 CHECK (approval_required IN (0, 1)),
  expected_source_content_hash TEXT NOT NULL CHECK (length(expected_source_content_hash) = 64),
  expected_context_version TEXT NOT NULL,
  expected_active_pointer_version INTEGER NOT NULL CHECK (expected_active_pointer_version > 0),
  policy_version TEXT NOT NULL,
  preview_hash TEXT NOT NULL CHECK (length(preview_hash) = 64),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  status TEXT NOT NULL DEFAULT 'CANDIDATE' CHECK (status IN (
    'CANDIDATE', 'PENDING_REVIEW', 'DEFERRED', 'ACTIVATED', 'REJECTED', 'EXPIRED', 'SUPERSEDED',
    'KEPT_ORIGINAL'
  )),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  review_requested_at TEXT,
  deferred_at TEXT,
  activated_at TEXT,
  rejected_at TEXT,
  expired_at TEXT,
  superseded_at TEXT,
  FOREIGN KEY (tenant_id, user_id, adaptation_id)
    REFERENCES training_adaptation_previews(tenant_id, user_id, adaptation_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id, family_id)
    REFERENCES training_plan_families(tenant_id, user_id, family_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id, family_id, source_revision_id)
    REFERENCES training_plan_revisions(tenant_id, user_id, family_id, revision_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id, family_id, proposed_revision_id)
    REFERENCES training_plan_revisions(tenant_id, user_id, family_id, revision_id) ON DELETE CASCADE,
  UNIQUE (tenant_id, user_id, idempotency_key),
  UNIQUE (tenant_id, user_id, adaptation_id),
  UNIQUE (tenant_id, user_id, proposal_id),
  UNIQUE (tenant_id, user_id, proposed_revision_id),
  UNIQUE (tenant_id, user_id, decision_id)
);

CREATE INDEX IF NOT EXISTS idx_training_adaptation_proposals_scope_status
  ON training_adaptation_proposals(tenant_id, user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_training_adaptation_proposals_source
  ON training_adaptation_proposals(tenant_id, user_id, source_revision_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_training_adaptation_proposals_material
  ON training_adaptation_proposals(tenant_id, user_id, material_fingerprint, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_training_adaptation_family_open_proposal
  ON training_adaptation_proposals(tenant_id, user_id, family_id)
  WHERE status IN ('CANDIDATE', 'PENDING_REVIEW', 'DEFERRED');

CREATE TABLE IF NOT EXISTS training_adaptation_lifecycle_events (
  event_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'PREVIEWED', 'REVIEW_REQUESTED', 'SUPPRESSED', 'REJECTED', 'DEFERRED',
    'EXPIRED', 'SUPERSEDED', 'ACTIVATED', 'KEPT_ORIGINAL'
  )),
  reason_code TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id, user_id, proposal_id)
    REFERENCES training_adaptation_proposals(tenant_id, user_id, proposal_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_training_adaptation_lifecycle_scope
  ON training_adaptation_lifecycle_events(tenant_id, user_id, proposal_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_training_adaptation_proposals_immutable_contract
BEFORE UPDATE ON training_adaptation_proposals
WHEN NEW.proposal_id IS NOT OLD.proposal_id
  OR NEW.adaptation_id IS NOT OLD.adaptation_id
  OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.user_id IS NOT OLD.user_id
  OR NEW.family_id IS NOT OLD.family_id
  OR NEW.source_revision_id IS NOT OLD.source_revision_id
  OR NEW.proposed_revision_id IS NOT OLD.proposed_revision_id
  OR NEW.scope IS NOT OLD.scope
  OR NEW.trigger_kind IS NOT OLD.trigger_kind
  OR NEW.option_kind IS NOT OLD.option_kind
  OR NEW.selected_option_id IS NOT OLD.selected_option_id
  OR NEW.option_hash IS NOT OLD.option_hash
  OR NEW.material_fingerprint IS NOT OLD.material_fingerprint
  OR NEW.explicit_input_json IS NOT OLD.explicit_input_json
  OR NEW.current_state_json IS NOT OLD.current_state_json
  OR NEW.proposed_state_json IS NOT OLD.proposed_state_json
  OR NEW.differences_json IS NOT OLD.differences_json
  OR NEW.evidence_json IS NOT OLD.evidence_json
  OR NEW.rationale IS NOT OLD.rationale
  OR NEW.expected_benefit IS NOT OLD.expected_benefit
  OR NEW.possible_downside IS NOT OLD.possible_downside
  OR NEW.reversibility IS NOT OLD.reversibility
  OR NEW.future_session_effect IS NOT OLD.future_session_effect
  OR NEW.approval_required IS NOT OLD.approval_required
  OR NEW.expected_source_content_hash IS NOT OLD.expected_source_content_hash
  OR NEW.expected_context_version IS NOT OLD.expected_context_version
  OR NEW.expected_active_pointer_version IS NOT OLD.expected_active_pointer_version
  OR NEW.policy_version IS NOT OLD.policy_version
  OR NEW.preview_hash IS NOT OLD.preview_hash
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.request_hash IS NOT OLD.request_hash
  OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'training adaptation proposal contract is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_training_adaptation_previews_immutable_update
BEFORE UPDATE ON training_adaptation_previews
BEGIN
  SELECT RAISE(ABORT, 'training adaptation preview is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_training_adaptation_previews_no_delete
BEFORE DELETE ON training_adaptation_previews
WHEN NOT EXISTS (
  SELECT 1 FROM training_revision_erasure_authorizations authorization
   WHERE authorization.subject_user_id = OLD.user_id
     AND datetime(authorization.expires_at) >= datetime('now')
)
BEGIN
  SELECT RAISE(ABORT, 'training adaptation preview is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_training_adaptation_proposals_no_delete
BEFORE DELETE ON training_adaptation_proposals
WHEN NOT EXISTS (
  SELECT 1 FROM training_revision_erasure_authorizations authorization
   WHERE authorization.subject_user_id = OLD.user_id
     AND datetime(authorization.expires_at) >= datetime('now')
)
BEGIN
  SELECT RAISE(ABORT, 'training adaptation proposal is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_training_adaptation_proposals_decision_binding
BEFORE UPDATE OF decision_id ON training_adaptation_proposals
WHEN OLD.decision_id IS NOT NULL OR NEW.decision_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'training adaptation decision binding is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_training_adaptation_proposals_lifecycle
BEFORE UPDATE OF status ON training_adaptation_proposals
WHEN NOT (
  (OLD.status = 'CANDIDATE' AND NEW.status IN ('PENDING_REVIEW', 'SUPERSEDED', 'EXPIRED', 'KEPT_ORIGINAL')) OR
  (OLD.status = 'PENDING_REVIEW' AND NEW.status IN ('DEFERRED', 'ACTIVATED', 'REJECTED', 'EXPIRED', 'SUPERSEDED')) OR
  (OLD.status = 'DEFERRED' AND NEW.status IN ('PENDING_REVIEW', 'ACTIVATED', 'REJECTED', 'EXPIRED', 'SUPERSEDED')) OR
  (OLD.status = NEW.status)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid training adaptation proposal lifecycle transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_training_adaptation_lifecycle_events_immutable_update
BEFORE UPDATE ON training_adaptation_lifecycle_events
BEGIN
  SELECT RAISE(ABORT, 'training adaptation lifecycle events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_training_adaptation_lifecycle_events_immutable_delete
BEFORE DELETE ON training_adaptation_lifecycle_events
WHEN NOT EXISTS (
  SELECT 1 FROM training_revision_erasure_authorizations authorization
   WHERE authorization.subject_user_id = OLD.user_id
     AND datetime(authorization.expires_at) >= datetime('now')
)
BEGIN
  SELECT RAISE(ABORT, 'training adaptation lifecycle events are append-only');
END;

-- Historical scope values remain untouched. This compatibility view exposes
-- canonical scope without relabeling legacy audit records destructively.
CREATE VIEW IF NOT EXISTS training_plan_adaptation_scope_v1 AS
SELECT id AS legacy_adaptation_id,
       plan_id,
       CASE scope
         WHEN 'session' THEN 'SESSION'
         WHEN 'week' THEN 'WEEK'
         WHEN 'plan' THEN 'FULL_PLAN'
         ELSE NULL
       END AS canonical_scope,
       scope AS legacy_scope,
       trigger_type,
       created_at
  FROM training_plan_adaptations;
