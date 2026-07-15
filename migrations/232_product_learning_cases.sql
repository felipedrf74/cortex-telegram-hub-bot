-- 232: Governed, tenant-safe product learning cases.
--
-- Cases contain redacted product evidence and expected contracts only. They
-- never contain raw calendar/private content and cannot become golden without
-- a reviewed lifecycle transition plus durable evidence references.

CREATE TABLE IF NOT EXISTS product_learning_cases (
  case_id TEXT NOT NULL CHECK (length(case_id) BETWEEN 1 AND 160),
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 80),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('observed', 'candidate', 'reviewed', 'golden', 'retired')),
  privacy_class TEXT NOT NULL CHECK (privacy_class IN ('public', 'redacted-product', 'sensitive-no-export')),
  redacted_input_json TEXT NOT NULL CHECK (json_valid(redacted_input_json)),
  expected_contract_json TEXT NOT NULL CHECK (json_valid(expected_contract_json)),
  evidence_references_json TEXT NOT NULL CHECK (json_valid(evidence_references_json)),
  producer_version TEXT NOT NULL CHECK (length(producer_version) BETWEEN 1 AND 120),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  observed_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT,
  review_approval_reference TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, user_id, case_id),
  CHECK (datetime(observed_at) IS NOT NULL),
  CHECK (datetime(expires_at) IS NOT NULL AND datetime(expires_at) > datetime(observed_at)),
  CHECK (reviewed_at IS NULL OR (
    datetime(reviewed_at) IS NOT NULL
    AND datetime(reviewed_at) > datetime(observed_at)
    AND datetime(reviewed_at) <= datetime(expires_at)
  )),
  CHECK (lifecycle NOT IN ('reviewed', 'golden') OR reviewed_at IS NOT NULL),
  CHECK (lifecycle NOT IN ('reviewed', 'golden') OR length(reviewed_by) BETWEEN 1 AND 80),
  CHECK (lifecycle NOT IN ('reviewed', 'golden') OR length(review_approval_reference) BETWEEN 1 AND 400),
  CHECK (lifecycle IN ('reviewed', 'golden', 'retired') OR (reviewed_at IS NULL AND reviewed_by IS NULL AND review_approval_reference IS NULL)),
  CHECK (lifecycle <> 'retired' OR (
    (reviewed_at IS NULL AND reviewed_by IS NULL AND review_approval_reference IS NULL)
    OR (reviewed_at IS NOT NULL AND length(reviewed_by) BETWEEN 1 AND 80 AND length(review_approval_reference) BETWEEN 1 AND 400)
  )),
  CHECK (lifecycle <> 'golden' OR json_array_length(evidence_references_json) > 0),
  CHECK (NOT (lifecycle = 'golden' AND privacy_class = 'sensitive-no-export'))
);

CREATE TABLE IF NOT EXISTS product_learning_case_transitions (
  transition_id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  case_id TEXT NOT NULL,
  from_lifecycle TEXT,
  to_lifecycle TEXT NOT NULL CHECK (to_lifecycle IN ('observed', 'candidate', 'reviewed', 'golden', 'retired')),
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 80),
  approval_reference TEXT,
  transitioned_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id, user_id, case_id)
    REFERENCES product_learning_cases(tenant_id, user_id, case_id)
    ON DELETE CASCADE
);

-- A review receipt is created only from a completed, user-scoped Decision
-- Center execution for this exact case. The caller never supplies reviewer or
-- timestamp authority: both values are derived from the server-side execution.
CREATE TABLE IF NOT EXISTS product_learning_case_review_approvals (
  approval_reference TEXT PRIMARY KEY CHECK (
    length(approval_reference) BETWEEN 1 AND 400
    AND approval_reference GLOB 'approval://product-learning/*'
  ),
  tenant_id INTEGER NOT NULL CHECK (tenant_id > 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  case_id TEXT NOT NULL,
  action_execution_id TEXT NOT NULL UNIQUE,
  decision_id TEXT NOT NULL,
  action_id TEXT NOT NULL CHECK (action_id = 'approve_product_learning_case'),
  reviewed_by TEXT NOT NULL CHECK (length(reviewed_by) BETWEEN 1 AND 80),
  reviewed_at TEXT NOT NULL CHECK (datetime(reviewed_at) IS NOT NULL),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, user_id, case_id),
  FOREIGN KEY (action_execution_id)
    REFERENCES decision_action_executions(action_execution_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (decision_id)
    REFERENCES notification_center_items(item_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, user_id, case_id)
    REFERENCES product_learning_cases(tenant_id, user_id, case_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_product_learning_cases_scope_lifecycle
  ON product_learning_cases(tenant_id, user_id, lifecycle, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_product_learning_cases_expiry
  ON product_learning_cases(expires_at)
  WHERE lifecycle <> 'retired';

CREATE INDEX IF NOT EXISTS idx_product_learning_case_transitions_scope
  ON product_learning_case_transitions(tenant_id, user_id, case_id, transitioned_at);

CREATE INDEX IF NOT EXISTS idx_product_learning_review_approvals_scope
  ON product_learning_case_review_approvals(tenant_id, user_id, case_id, reviewed_at);

CREATE TRIGGER IF NOT EXISTS trg_product_learning_review_approvals_execution_guard
BEFORE INSERT ON product_learning_case_review_approvals
WHEN NEW.reviewed_by <> ('user:' || NEW.user_id)
  OR datetime(NEW.reviewed_at) > datetime('now')
  OR NOT EXISTS (
    SELECT 1
      FROM decision_action_executions execution
      JOIN notification_center_items item
        ON item.item_id = execution.decision_id
       AND item.user_id = execution.user_id
       AND item.tenant_id = execution.tenant_id
      JOIN notification_intents intent
        ON intent.intent_id = item.intent_id
       AND intent.user_id = item.user_id
       AND intent.tenant_id = item.tenant_id
     WHERE execution.action_execution_id = NEW.action_execution_id
       AND execution.decision_id = NEW.decision_id
       AND execution.user_id = NEW.user_id
       AND execution.tenant_id = NEW.tenant_id
       AND execution.action_id = NEW.action_id
       AND execution.action_id = 'approve_product_learning_case'
       AND execution.executor_skill = 'training'
       AND execution.status = 'succeeded'
       AND execution.completed_at IS NOT NULL
       AND datetime(execution.completed_at) IS NOT NULL
       AND datetime(execution.completed_at) <= datetime('now')
       AND datetime(execution.completed_at) = datetime(NEW.reviewed_at)
       AND json_extract(execution.result_json, '$.productLearningCaseId') = NEW.case_id
       AND json_extract(execution.result_json, '$.approved') = 1
       AND item.source_skill = 'training'
       AND item.status = 'actioned'
       AND item.decision_state = 'completed'
       AND intent.source_skill = 'training'
       AND intent.related_entity_type = 'product_learning_case'
       AND intent.related_entity_id = NEW.case_id
  )
BEGIN
  SELECT RAISE(ABORT, 'product learning approval requires a completed scoped Decision Center execution');
END;

CREATE TRIGGER IF NOT EXISTS trg_product_learning_review_approvals_no_update
BEFORE UPDATE ON product_learning_case_review_approvals
BEGIN
  SELECT RAISE(ABORT, 'product learning review approvals are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_product_learning_review_approvals_no_delete
BEFORE DELETE ON product_learning_case_review_approvals
WHEN NOT EXISTS (
  SELECT 1 FROM training_revision_erasure_authorizations authorization
   WHERE authorization.subject_user_id = OLD.user_id
     AND datetime(authorization.expires_at) >= datetime('now')
)
BEGIN
  SELECT RAISE(ABORT, 'product learning review approvals require erasure authorization');
END;

CREATE TRIGGER IF NOT EXISTS trg_product_learning_cases_observed_insert
BEFORE INSERT ON product_learning_cases
WHEN NEW.lifecycle <> 'observed'
  OR NEW.reviewed_at IS NOT NULL
  OR NEW.reviewed_by IS NOT NULL
  OR NEW.review_approval_reference IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'new product learning cases must enter through observed lifecycle');
END;

CREATE TRIGGER IF NOT EXISTS trg_product_learning_cases_payload_guard
BEFORE INSERT ON product_learning_cases
WHEN NEW.owner <> 'training'
  OR NEW.case_id GLOB '*[^a-z0-9_.:-]*'
  OR NEW.producer_version GLOB '*[^a-z0-9_.:-]*'
  OR json_type(NEW.redacted_input_json, '$') <> 'object'
  OR json_type(NEW.expected_contract_json, '$') <> 'object'
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.redacted_input_json)
     WHERE key NOT IN ('kind', 'outcomeCode', 'subjectFingerprint')
  )
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.expected_contract_json)
     WHERE key <> 'contractId'
  )
  OR json_type(NEW.redacted_input_json, '$.kind') IS NOT 'text'
  OR json_type(NEW.redacted_input_json, '$.outcomeCode') IS NOT 'text'
  OR json_type(NEW.expected_contract_json, '$.contractId') IS NOT 'text'
  OR NOT (
    (json_extract(NEW.redacted_input_json, '$.kind') = 'plan_correction'
      AND json_extract(NEW.redacted_input_json, '$.outcomeCode') = 'user_corrected'
      AND json_extract(NEW.expected_contract_json, '$.contractId') = 'training.plan_correction.v1')
    OR (json_extract(NEW.redacted_input_json, '$.kind') = 'adaptation_accepted'
      AND json_extract(NEW.redacted_input_json, '$.outcomeCode') = 'user_approved'
      AND json_extract(NEW.expected_contract_json, '$.contractId') = 'training.adaptation.activation.v1')
    OR (json_extract(NEW.redacted_input_json, '$.kind') = 'adaptation_rejected'
      AND json_extract(NEW.redacted_input_json, '$.outcomeCode') = 'user_rejected'
      AND json_extract(NEW.expected_contract_json, '$.contractId') = 'training.adaptation.rejection.v1')
    OR (json_extract(NEW.redacted_input_json, '$.kind') = 'capacity_conflict_accuracy'
      AND json_extract(NEW.redacted_input_json, '$.outcomeCode') IN ('confirmed', 'corrected')
      AND json_extract(NEW.expected_contract_json, '$.contractId') = 'training.capacity_conflict.v1')
    OR (json_extract(NEW.redacted_input_json, '$.kind') = 'media_fallback'
      AND json_extract(NEW.redacted_input_json, '$.outcomeCode') IN ('fallback_used', 'fallback_failed')
      AND json_extract(NEW.expected_contract_json, '$.contractId') = 'training.media_fallback.v1')
    OR (json_extract(NEW.redacted_input_json, '$.kind') = 'media_missing_mapping'
      AND json_extract(NEW.redacted_input_json, '$.outcomeCode') IN ('mapping_missing', 'mapping_added')
      AND json_extract(NEW.expected_contract_json, '$.contractId') = 'training.media_mapping.v1')
    OR (json_extract(NEW.redacted_input_json, '$.kind') = 'compatibility_regression'
      AND json_extract(NEW.redacted_input_json, '$.outcomeCode') IN ('detected', 'resolved')
      AND json_extract(NEW.expected_contract_json, '$.contractId') = 'training.compatibility_regression.v1')
    OR (json_extract(NEW.redacted_input_json, '$.kind') = 'physical_device_observation'
      AND json_extract(NEW.redacted_input_json, '$.outcomeCode') IN ('passed', 'failed')
      AND json_extract(NEW.expected_contract_json, '$.contractId') = 'training.physical_device.v1')
  )
  OR (
    json_extract(NEW.redacted_input_json, '$.subjectFingerprint') IS NOT NULL
    AND (
      json_type(NEW.redacted_input_json, '$.subjectFingerprint') IS NOT 'text'
      OR
      length(json_extract(NEW.redacted_input_json, '$.subjectFingerprint')) <> 64
      OR json_extract(NEW.redacted_input_json, '$.subjectFingerprint') GLOB '*[^a-f0-9]*'
    )
  )
  OR json_type(NEW.evidence_references_json, '$') <> 'array'
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.evidence_references_json)
     WHERE type <> 'text'
       OR value GLOB '*@*'
       OR length(value) > 400
       OR NOT (
         value GLOB 'ci://*' OR value GLOB 'metric://*' OR value GLOB 'outcome://*'
         OR value GLOB 'approval://*' OR value GLOB 'release://*'
         OR value GLOB 'testflight://*' OR value GLOB 'external://*' OR value GLOB 'event://*'
       )
  )
BEGIN
  SELECT RAISE(ABORT, 'product learning case violates governed taxonomy or privacy boundary');
END;

CREATE TRIGGER IF NOT EXISTS trg_product_learning_cases_review_guard
BEFORE UPDATE OF lifecycle, reviewed_at, reviewed_by, review_approval_reference ON product_learning_cases
WHEN NEW.lifecycle = 'reviewed'
  AND (
    NEW.reviewed_by IS NULL
    OR NEW.reviewed_by GLOB '*[^a-z0-9_.:-]*'
    OR NEW.review_approval_reference IS NULL
    OR NEW.review_approval_reference NOT GLOB 'approval://*'
    OR NEW.review_approval_reference GLOB '*@*'
    OR NOT EXISTS (
      SELECT 1
        FROM product_learning_case_review_approvals approval
        JOIN decision_action_executions execution
          ON execution.action_execution_id = approval.action_execution_id
         AND execution.decision_id = approval.decision_id
         AND execution.user_id = approval.user_id
         AND execution.tenant_id = approval.tenant_id
        JOIN notification_center_items item
          ON item.item_id = execution.decision_id
         AND item.user_id = execution.user_id
         AND item.tenant_id = execution.tenant_id
        JOIN notification_intents intent
          ON intent.intent_id = item.intent_id
         AND intent.user_id = item.user_id
         AND intent.tenant_id = item.tenant_id
       WHERE approval.tenant_id = NEW.tenant_id
         AND approval.user_id = NEW.user_id
         AND approval.case_id = NEW.case_id
         AND approval.approval_reference = NEW.review_approval_reference
         AND approval.reviewed_by = NEW.reviewed_by
         AND datetime(approval.reviewed_at) = datetime(NEW.reviewed_at)
         AND execution.action_id = 'approve_product_learning_case'
         AND execution.executor_skill = 'training'
         AND execution.status = 'succeeded'
         AND execution.completed_at IS NOT NULL
         AND datetime(execution.completed_at) <= datetime('now')
         AND json_extract(execution.result_json, '$.productLearningCaseId') = NEW.case_id
         AND json_extract(execution.result_json, '$.approved') = 1
         AND item.source_skill = 'training'
         AND item.status = 'actioned'
         AND item.decision_state = 'completed'
         AND intent.source_skill = 'training'
         AND intent.related_entity_type = 'product_learning_case'
         AND intent.related_entity_id = NEW.case_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'product learning review proof violates governance boundary');
END;

CREATE TRIGGER IF NOT EXISTS trg_product_learning_cases_observed_audit
AFTER INSERT ON product_learning_cases
BEGIN
  INSERT INTO product_learning_case_transitions (
    transition_id, tenant_id, user_id, case_id, from_lifecycle,
    to_lifecycle, actor, approval_reference, transitioned_at
  ) VALUES (
    'plct_' || lower(hex(randomblob(16))), NEW.tenant_id, NEW.user_id, NEW.case_id,
    NULL, 'observed', 'system:observation', NULL, NEW.observed_at
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_product_learning_cases_scope_immutable
BEFORE UPDATE ON product_learning_cases
WHEN NEW.case_id IS NOT OLD.case_id
  OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.user_id IS NOT OLD.user_id
  OR NEW.owner IS NOT OLD.owner
  OR NEW.privacy_class IS NOT OLD.privacy_class
  OR NEW.redacted_input_json IS NOT OLD.redacted_input_json
  OR NEW.expected_contract_json IS NOT OLD.expected_contract_json
  OR NEW.evidence_references_json IS NOT OLD.evidence_references_json
  OR NEW.producer_version IS NOT OLD.producer_version
  OR NEW.confidence IS NOT OLD.confidence
  OR NEW.observed_at IS NOT OLD.observed_at
  OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'product learning case evidence is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_product_learning_cases_lifecycle
BEFORE UPDATE OF lifecycle ON product_learning_cases
WHEN NOT (
  (OLD.lifecycle = 'observed' AND NEW.lifecycle = 'candidate' AND datetime(NEW.expires_at) > datetime('now')) OR
  (OLD.lifecycle = 'observed' AND NEW.lifecycle = 'retired') OR
  (OLD.lifecycle = 'candidate' AND NEW.lifecycle = 'reviewed'
    AND NEW.reviewed_at IS NOT NULL
    AND NEW.reviewed_by IS NOT NULL
    AND NEW.review_approval_reference IS NOT NULL
    AND datetime(NEW.expires_at) > datetime('now')) OR
  (OLD.lifecycle = 'candidate' AND NEW.lifecycle = 'retired') OR
  (OLD.lifecycle = 'reviewed' AND NEW.lifecycle = 'golden'
    AND OLD.reviewed_at IS NOT NULL
    AND datetime(NEW.expires_at) > datetime('now')
    AND EXISTS (
      SELECT 1
        FROM product_learning_case_review_approvals approval
        JOIN decision_action_executions execution
          ON execution.action_execution_id = approval.action_execution_id
         AND execution.decision_id = approval.decision_id
         AND execution.user_id = approval.user_id
         AND execution.tenant_id = approval.tenant_id
        JOIN notification_center_items item
          ON item.item_id = execution.decision_id
         AND item.user_id = execution.user_id
         AND item.tenant_id = execution.tenant_id
        JOIN notification_intents intent
          ON intent.intent_id = item.intent_id
         AND intent.user_id = item.user_id
         AND intent.tenant_id = item.tenant_id
       WHERE approval.tenant_id = NEW.tenant_id
         AND approval.user_id = NEW.user_id
         AND approval.case_id = NEW.case_id
         AND approval.approval_reference = NEW.review_approval_reference
         AND approval.reviewed_by = NEW.reviewed_by
         AND datetime(approval.reviewed_at) = datetime(NEW.reviewed_at)
         AND execution.action_id = 'approve_product_learning_case'
         AND execution.executor_skill = 'training'
         AND execution.status = 'succeeded'
         AND execution.completed_at IS NOT NULL
         AND datetime(execution.completed_at) <= datetime('now')
         AND json_extract(execution.result_json, '$.productLearningCaseId') = NEW.case_id
         AND json_extract(execution.result_json, '$.approved') = 1
         AND item.source_skill = 'training'
         AND item.status = 'actioned'
         AND item.decision_state = 'completed'
         AND intent.source_skill = 'training'
         AND intent.related_entity_type = 'product_learning_case'
         AND intent.related_entity_id = NEW.case_id
    )) OR
  (OLD.lifecycle = 'reviewed' AND NEW.lifecycle = 'retired') OR
  (OLD.lifecycle = 'golden' AND NEW.lifecycle = 'retired') OR
  (OLD.lifecycle = NEW.lifecycle)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid product learning case lifecycle transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_product_learning_cases_review_immutable
BEFORE UPDATE OF reviewed_at, reviewed_by, review_approval_reference ON product_learning_cases
WHEN (
  NEW.reviewed_at IS NOT OLD.reviewed_at
  OR NEW.reviewed_by IS NOT OLD.reviewed_by
  OR NEW.review_approval_reference IS NOT OLD.review_approval_reference
)
  AND NOT (
    OLD.lifecycle = 'candidate'
    AND NEW.lifecycle = 'reviewed'
    AND OLD.reviewed_at IS NULL
    AND OLD.reviewed_by IS NULL
    AND OLD.review_approval_reference IS NULL
    AND NEW.reviewed_at IS NOT NULL
    AND NEW.reviewed_by IS NOT NULL
    AND NEW.review_approval_reference IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'product learning review evidence is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_product_learning_cases_transition_audit
AFTER UPDATE OF lifecycle ON product_learning_cases
WHEN NEW.lifecycle IS NOT OLD.lifecycle
BEGIN
  INSERT INTO product_learning_case_transitions (
    transition_id, tenant_id, user_id, case_id, from_lifecycle,
    to_lifecycle, actor, approval_reference, transitioned_at
  ) VALUES (
    'plct_' || lower(hex(randomblob(16))), NEW.tenant_id, NEW.user_id, NEW.case_id,
    OLD.lifecycle, NEW.lifecycle,
    CASE WHEN NEW.lifecycle = 'reviewed' THEN NEW.reviewed_by ELSE 'system:lifecycle' END,
    CASE WHEN NEW.lifecycle = 'reviewed' THEN NEW.review_approval_reference ELSE NULL END,
    CASE WHEN NEW.lifecycle = 'reviewed' THEN NEW.reviewed_at ELSE datetime('now') END
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_product_learning_cases_no_delete
BEFORE DELETE ON product_learning_cases
WHEN NOT EXISTS (
  SELECT 1 FROM training_revision_erasure_authorizations authorization
   WHERE authorization.subject_user_id = OLD.user_id
     AND datetime(authorization.expires_at) >= datetime('now')
)
BEGIN
  SELECT RAISE(ABORT, 'product learning cases must be retired, not deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_product_learning_case_transitions_no_update
BEFORE UPDATE ON product_learning_case_transitions
BEGIN
  SELECT RAISE(ABORT, 'product learning transition history is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_product_learning_case_transitions_no_delete
BEFORE DELETE ON product_learning_case_transitions
WHEN NOT EXISTS (
  SELECT 1 FROM training_revision_erasure_authorizations authorization
   WHERE authorization.subject_user_id = OLD.user_id
     AND datetime(authorization.expires_at) >= datetime('now')
)
BEGIN
  SELECT RAISE(ABORT, 'product learning transition history requires erasure authorization');
END;
