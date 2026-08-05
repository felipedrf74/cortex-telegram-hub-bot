-- 282: durable, provider-fenced Secretary cross-skill preemption state.
--
-- Choice A is deliberately two phase. The lower-ranked loser vN remains
-- active and owns its exact provider mapping while cleanup is pending. Its
-- vN+1 replacement and the winner are only proposed local rows. A confirmed
-- exact-id provider delete, the loser lifecycle transition, and dependency
-- settlement are one transaction; only then may the winner become ready.

CREATE TABLE IF NOT EXISTS secretary_agenda_preemption_operations (
  operation_id TEXT PRIMARY KEY
    CHECK (length(trim(operation_id)) > 0),
  owner_user_id INTEGER NOT NULL CHECK (owner_user_id > 0),
  tenant_id TEXT NOT NULL CHECK (length(trim(tenant_id)) > 0),
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) > 0),
  request_hash TEXT NOT NULL
    CHECK (
      length(request_hash) = 64
      AND request_hash NOT GLOB '*[^0-9a-f]*'
    ),
  winner_agenda_item_id TEXT NOT NULL
    CHECK (length(trim(winner_agenda_item_id)) > 0),
  winner_agenda_version INTEGER NOT NULL CHECK (winner_agenda_version > 0),
  winner_source_skill TEXT NOT NULL
    CHECK (winner_source_skill IN ('training', 'cooking', 'finance', 'content', 'secretary')),
  winner_source_intent_id TEXT NOT NULL
    CHECK (length(trim(winner_source_intent_id)) > 0),
  winner_source_shape_hash TEXT NOT NULL
    CHECK (length(trim(winner_source_shape_hash)) > 0),
  winner_final_lifecycle_state TEXT NOT NULL
    CHECK (winner_final_lifecycle_state IN ('scheduled', 'reflowed', 'compressed')),
  winner_provider_target TEXT NOT NULL
    CHECK (winner_provider_target IN ('google', 'outlook')),
  prior_winner_agenda_item_id TEXT,
  prior_winner_agenda_version INTEGER,
  prior_winner_provider_source TEXT
    CHECK (prior_winner_provider_source IS NULL OR prior_winner_provider_source IN ('google', 'outlook')),
  prior_winner_provider_event_id TEXT,
  arbitration_policy_version TEXT NOT NULL
    CHECK (length(trim(arbitration_policy_version)) > 0),
  state TEXT NOT NULL
    CHECK (state IN (
      'cleanup_pending', 'cleanup_blocked', 'winner_ready',
      'winner_reconcile', 'completed', 'terminal_failure', 'canceled'
    )),
  failure_disposition TEXT
    CHECK (
      failure_disposition IS NULL
      OR failure_disposition IN ('terminal', 'retryable', 'reconcile')
    ),
  failure_code TEXT,
  retry_after_at TEXT,
  cancel_requested_at TEXT,
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0),
  completed_at TEXT,
  CHECK (
    (prior_winner_agenda_item_id IS NULL AND prior_winner_agenda_version IS NULL)
    OR (
      prior_winner_agenda_item_id IS NOT NULL
      AND length(trim(prior_winner_agenda_item_id)) > 0
      AND prior_winner_agenda_version IS NOT NULL
      AND prior_winner_agenda_version > 0
      AND prior_winner_agenda_version < winner_agenda_version
    )
  ),
  CHECK (
    (prior_winner_agenda_item_id IS NULL
      AND prior_winner_provider_source IS NULL
      AND prior_winner_provider_event_id IS NULL)
    OR (
      prior_winner_agenda_item_id IS NOT NULL
      AND (
        (prior_winner_provider_source IS NULL AND prior_winner_provider_event_id IS NULL)
        OR (
          prior_winner_provider_source IS NOT NULL
          AND prior_winner_provider_event_id IS NOT NULL
          AND length(trim(prior_winner_provider_event_id)) > 0
        )
      )
    )
  ),
  CHECK (
    (state = 'completed' AND completed_at IS NOT NULL)
    OR (state <> 'completed' AND completed_at IS NULL)
  ),
  CHECK (state <> 'canceled' OR cancel_requested_at IS NOT NULL),
  CHECK (
    state <> 'terminal_failure'
    OR (
      failure_disposition = 'terminal'
      AND failure_code IS NOT NULL
      AND length(trim(failure_code)) > 0
    )
  ),
  CHECK (retry_after_at IS NULL OR failure_disposition = 'retryable')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_secretary_agenda_preemption_operation_idempotency
  ON secretary_agenda_preemption_operations(owner_user_id, tenant_id, idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_secretary_agenda_preemption_operation_request
  ON secretary_agenda_preemption_operations(owner_user_id, tenant_id, request_hash);

CREATE UNIQUE INDEX IF NOT EXISTS idx_secretary_agenda_preemption_operation_winner
  ON secretary_agenda_preemption_operations(
    owner_user_id, tenant_id, winner_agenda_item_id, winner_agenda_version
  );

CREATE INDEX IF NOT EXISTS idx_secretary_agenda_preemption_operation_state
  ON secretary_agenda_preemption_operations(
    owner_user_id, tenant_id, state, retry_after_at, updated_at
  );

CREATE TABLE IF NOT EXISTS secretary_agenda_preemption_dependencies (
  dependency_id TEXT PRIMARY KEY
    CHECK (length(trim(dependency_id)) > 0),
  operation_id TEXT NOT NULL
    REFERENCES secretary_agenda_preemption_operations(operation_id) ON DELETE CASCADE,
  owner_user_id INTEGER NOT NULL CHECK (owner_user_id > 0),
  tenant_id TEXT NOT NULL CHECK (length(trim(tenant_id)) > 0),
  loser_agenda_item_id TEXT NOT NULL
    CHECK (length(trim(loser_agenda_item_id)) > 0),
  loser_agenda_version INTEGER NOT NULL CHECK (loser_agenda_version > 0),
  loser_replacement_agenda_item_id TEXT NOT NULL
    CHECK (length(trim(loser_replacement_agenda_item_id)) > 0),
  loser_replacement_version INTEGER NOT NULL CHECK (loser_replacement_version > 0),
  loser_source_skill TEXT NOT NULL
    CHECK (loser_source_skill IN ('training', 'cooking', 'finance', 'content', 'secretary')),
  loser_source_intent_id TEXT NOT NULL
    CHECK (length(trim(loser_source_intent_id)) > 0),
  loser_source_shape_hash TEXT NOT NULL
    CHECK (length(trim(loser_source_shape_hash)) > 0),
  loser_arbitration_score INTEGER NOT NULL,
  loser_arbitration_deadline_at TEXT,
  loser_arbitration_flexibility TEXT NOT NULL
    CHECK (loser_arbitration_flexibility IN ('flexible', 'compressible', 'splittable')),
  loser_arbitration_policy_version TEXT NOT NULL
    CHECK (length(trim(loser_arbitration_policy_version)) > 0),
  loser_provider_target TEXT NOT NULL
    CHECK (loser_provider_target IN ('google', 'outlook')),
  loser_provider_source TEXT NOT NULL
    CHECK (loser_provider_source IN ('google', 'outlook')),
  loser_provider_event_id TEXT NOT NULL
    CHECK (length(trim(loser_provider_event_id)) > 0),
  provider_identity_hash TEXT NOT NULL
    CHECK (
      length(provider_identity_hash) = 64
      AND provider_identity_hash NOT GLOB '*[^0-9a-f]*'
    ),
  state TEXT NOT NULL
    CHECK (state IN ('pending', 'in_progress', 'retryable', 'reconcile', 'terminal', 'satisfied')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_token TEXT,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  failure_disposition TEXT
    CHECK (
      failure_disposition IS NULL
      OR failure_disposition IN ('terminal', 'retryable', 'reconcile')
    ),
  failure_code TEXT,
  retry_after_at TEXT,
  provider_deleted_at TEXT,
  satisfied_at TEXT,
  last_checked_at TEXT,
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0),
  CHECK (loser_replacement_version = loser_agenda_version + 1),
  CHECK (loser_replacement_agenda_item_id <> loser_agenda_item_id),
  CHECK (loser_provider_target = loser_provider_source),
  CHECK (
    (state = 'in_progress'
      AND lease_token IS NOT NULL
      AND length(trim(lease_token)) > 0
      AND lease_expires_at IS NOT NULL
      AND heartbeat_at IS NOT NULL)
    OR
    (state <> 'in_progress'
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND heartbeat_at IS NULL)
  ),
  CHECK (state <> 'pending' OR attempt_count = 0),
  CHECK (state = 'pending' OR attempt_count > 0),
  CHECK (
    (state = 'satisfied'
      AND provider_deleted_at IS NOT NULL
      AND satisfied_at IS NOT NULL
      AND failure_disposition IS NULL
      AND failure_code IS NULL)
    OR
    (state <> 'satisfied' AND provider_deleted_at IS NULL AND satisfied_at IS NULL)
  ),
  CHECK (
    (state IN ('pending', 'in_progress')
      AND failure_disposition IS NULL
      AND failure_code IS NULL)
    OR (state = 'retryable'
      AND failure_disposition = 'retryable'
      AND failure_code IS NOT NULL
      AND length(trim(failure_code)) > 0)
    OR (state = 'reconcile'
      AND failure_disposition = 'reconcile'
      AND failure_code IS NOT NULL
      AND length(trim(failure_code)) > 0)
    OR (state = 'terminal'
      AND failure_disposition = 'terminal'
      AND failure_code IS NOT NULL
      AND length(trim(failure_code)) > 0)
    OR (state = 'satisfied'
      AND failure_disposition IS NULL
      AND failure_code IS NULL)
  ),
  CHECK (retry_after_at IS NULL OR state = 'retryable')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_secretary_agenda_preemption_dependency_loser
  ON secretary_agenda_preemption_dependencies(
    owner_user_id, tenant_id, loser_agenda_item_id, loser_agenda_version
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_secretary_agenda_preemption_dependency_replacement
  ON secretary_agenda_preemption_dependencies(
    owner_user_id, tenant_id,
    loser_replacement_agenda_item_id, loser_replacement_version
  );

CREATE INDEX IF NOT EXISTS idx_secretary_agenda_preemption_dependency_operation
  ON secretary_agenda_preemption_dependencies(operation_id, state, updated_at);

CREATE INDEX IF NOT EXISTS idx_secretary_agenda_preemption_dependency_cleanup
  ON secretary_agenda_preemption_dependencies(
    owner_user_id, tenant_id,
    loser_replacement_agenda_item_id, loser_replacement_version, state
  );

CREATE INDEX IF NOT EXISTS idx_secretary_agenda_preemption_dependency_lease
  ON secretary_agenda_preemption_dependencies(state, lease_expires_at, retry_after_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_secretary_agenda_preemption_dependency_unresolved_event
  ON secretary_agenda_preemption_dependencies(
    owner_user_id, tenant_id, loser_provider_source, loser_provider_event_id
  )
  WHERE state <> 'satisfied';

CREATE UNIQUE INDEX IF NOT EXISTS idx_secretary_agenda_preemption_dependency_unresolved_identity
  ON secretary_agenda_preemption_dependencies(
    owner_user_id, tenant_id, provider_identity_hash
  )
  WHERE state <> 'satisfied';

-- The operation must bind an exact proposed winner. A version greater than one
-- names its exact prior logical winner; the prior row remains active until the
-- cleanup graph is settled.
CREATE TRIGGER IF NOT EXISTS trg_secretary_preemption_operation_insert_guard
BEFORE INSERT ON secretary_agenda_preemption_operations
FOR EACH ROW
WHEN NEW.state <> 'cleanup_pending'
  OR NEW.failure_disposition IS NOT NULL
  OR NEW.failure_code IS NOT NULL
  OR NEW.retry_after_at IS NOT NULL
  OR NEW.cancel_requested_at IS NOT NULL
  OR NEW.completed_at IS NOT NULL
  OR NOT EXISTS (
    SELECT 1
      FROM secretary_agenda_items AS winner
     WHERE winner.agenda_item_id = NEW.winner_agenda_item_id
       AND winner.version = NEW.winner_agenda_version
       AND winner.owner_user_id = NEW.owner_user_id
       AND winner.tenant_id = NEW.tenant_id
       AND winner.source_skill = NEW.winner_source_skill
       AND winner.source_intent_id = NEW.winner_source_intent_id
       AND winner.source_shape_hash = NEW.winner_source_shape_hash
       AND winner.lifecycle_state = 'proposed'
       AND winner.provider_sync_state = 'not_synced'
       AND winner.provider_event_id IS NULL
       AND winner.provider_source IS NULL
       AND winner.provider_target = NEW.winner_provider_target
       AND winner.arbitration_score IS NOT NULL
       AND winner.arbitration_flexibility IN ('fixed', 'flexible', 'compressible', 'splittable')
       AND winner.arbitration_policy_version = NEW.arbitration_policy_version
  )
  OR (
    NEW.prior_winner_agenda_item_id IS NULL
    AND NEW.winner_agenda_version > 1
    AND (
      NOT EXISTS (
        SELECT 1
          FROM secretary_agenda_items AS previous
         WHERE previous.owner_user_id = NEW.owner_user_id
           AND previous.tenant_id = NEW.tenant_id
           AND previous.source_skill = NEW.winner_source_skill
           AND previous.source_intent_id = NEW.winner_source_intent_id
           AND previous.version = NEW.winner_agenda_version - 1
      )
      OR EXISTS (
        SELECT 1
          FROM secretary_agenda_items AS active_prior
         WHERE active_prior.owner_user_id = NEW.owner_user_id
           AND active_prior.tenant_id = NEW.tenant_id
           AND active_prior.source_skill = NEW.winner_source_skill
           AND active_prior.source_intent_id = NEW.winner_source_intent_id
           AND active_prior.version < NEW.winner_agenda_version
           AND active_prior.lifecycle_state IN ('proposed', 'scheduled', 'synced', 'reflowed', 'compressed', 'failed_sync')
      )
    )
  )
  OR (
    NEW.prior_winner_agenda_item_id IS NOT NULL
    AND (
      NEW.prior_winner_agenda_version <> NEW.winner_agenda_version - 1
      OR NOT EXISTS (
        SELECT 1
          FROM secretary_agenda_items AS prior
         WHERE prior.agenda_item_id = NEW.prior_winner_agenda_item_id
           AND prior.version = NEW.prior_winner_agenda_version
           AND prior.owner_user_id = NEW.owner_user_id
           AND prior.tenant_id = NEW.tenant_id
           AND prior.source_skill = NEW.winner_source_skill
           AND prior.source_intent_id = NEW.winner_source_intent_id
           AND prior.lifecycle_state IN ('scheduled', 'synced', 'reflowed', 'compressed', 'failed_sync')
           AND (prior.provider_target IS NULL OR prior.provider_target = NEW.winner_provider_target)
           AND (
             (
               prior.provider_event_id IS NULL
               AND prior.provider_source IS NULL
               AND NEW.prior_winner_provider_event_id IS NULL
               AND NEW.prior_winner_provider_source IS NULL
             )
             OR (
               prior.provider_sync_state = 'synced'
               AND prior.provider_event_id = NEW.prior_winner_provider_event_id
               AND prior.provider_source = NEW.prior_winner_provider_source
               AND NEW.prior_winner_provider_source = NEW.winner_provider_target
             )
           )
      )
    )
  )
  OR EXISTS (
    SELECT 1
      FROM secretary_agenda_items AS later
     WHERE later.owner_user_id = NEW.owner_user_id
       AND later.tenant_id = NEW.tenant_id
       AND later.source_skill = NEW.winner_source_skill
       AND later.source_intent_id = NEW.winner_source_intent_id
       AND later.version > NEW.winner_agenda_version
  )
BEGIN
  SELECT RAISE(ABORT, 'SECRETARY_PREEMPTION_OPERATION_SCOPE_MISMATCH');
END;

CREATE TRIGGER IF NOT EXISTS trg_secretary_preemption_operation_identity_immutable
BEFORE UPDATE ON secretary_agenda_preemption_operations
FOR EACH ROW
WHEN NEW.operation_id IS NOT OLD.operation_id
  OR NEW.owner_user_id IS NOT OLD.owner_user_id
  OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.request_hash IS NOT OLD.request_hash
  OR NEW.winner_agenda_item_id IS NOT OLD.winner_agenda_item_id
  OR NEW.winner_agenda_version IS NOT OLD.winner_agenda_version
  OR NEW.winner_source_skill IS NOT OLD.winner_source_skill
  OR NEW.winner_source_intent_id IS NOT OLD.winner_source_intent_id
  OR NEW.winner_source_shape_hash IS NOT OLD.winner_source_shape_hash
  OR NEW.winner_final_lifecycle_state IS NOT OLD.winner_final_lifecycle_state
  OR NEW.winner_provider_target IS NOT OLD.winner_provider_target
  OR NEW.prior_winner_agenda_item_id IS NOT OLD.prior_winner_agenda_item_id
  OR NEW.prior_winner_agenda_version IS NOT OLD.prior_winner_agenda_version
  OR NEW.prior_winner_provider_source IS NOT OLD.prior_winner_provider_source
  OR NEW.prior_winner_provider_event_id IS NOT OLD.prior_winner_provider_event_id
  OR NEW.arbitration_policy_version IS NOT OLD.arbitration_policy_version
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'SECRETARY_PREEMPTION_OPERATION_IDENTITY_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_secretary_preemption_operation_state_transition
BEFORE UPDATE OF state ON secretary_agenda_preemption_operations
FOR EACH ROW
WHEN NEW.state IS NOT OLD.state
  AND NOT (
    (OLD.state = 'cleanup_pending' AND NEW.state IN ('cleanup_blocked', 'winner_ready', 'terminal_failure', 'canceled'))
    OR (OLD.state = 'cleanup_blocked' AND NEW.state IN ('cleanup_pending', 'winner_ready', 'terminal_failure', 'canceled'))
    OR (OLD.state = 'winner_ready' AND NEW.state IN ('winner_reconcile', 'completed', 'terminal_failure', 'canceled'))
    OR (OLD.state = 'winner_reconcile' AND NEW.state IN ('winner_ready', 'completed', 'terminal_failure', 'canceled'))
  )
BEGIN
  SELECT RAISE(ABORT, 'SECRETARY_PREEMPTION_OPERATION_STATE_INVALID');
END;

CREATE TRIGGER IF NOT EXISTS trg_secretary_preemption_operation_winner_ready
BEFORE UPDATE OF state ON secretary_agenda_preemption_operations
FOR EACH ROW
WHEN NEW.state = 'winner_ready'
  AND (
    NOT EXISTS (
      SELECT 1 FROM secretary_agenda_preemption_dependencies AS dependency
       WHERE dependency.operation_id = NEW.operation_id
    )
    OR EXISTS (
      SELECT 1 FROM secretary_agenda_preemption_dependencies AS dependency
       WHERE dependency.operation_id = NEW.operation_id
         AND dependency.state <> 'satisfied'
    )
    OR NOT EXISTS (
      SELECT 1
        FROM secretary_agenda_items AS winner
       WHERE winner.agenda_item_id = NEW.winner_agenda_item_id
         AND winner.version = NEW.winner_agenda_version
         AND winner.owner_user_id = NEW.owner_user_id
         AND winner.tenant_id = NEW.tenant_id
         AND winner.source_skill = NEW.winner_source_skill
         AND winner.source_intent_id = NEW.winner_source_intent_id
         AND winner.lifecycle_state = NEW.winner_final_lifecycle_state
         AND winner.provider_sync_state = 'not_synced'
         AND winner.provider_event_id IS NULL
         AND winner.provider_source IS NULL
         AND winner.provider_target = NEW.winner_provider_target
    )
    OR (
      NEW.prior_winner_agenda_item_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
          FROM secretary_agenda_items AS prior
         WHERE prior.agenda_item_id = NEW.prior_winner_agenda_item_id
           AND prior.version = NEW.prior_winner_agenda_version
           AND prior.owner_user_id = NEW.owner_user_id
           AND prior.tenant_id = NEW.tenant_id
           AND prior.source_skill = NEW.winner_source_skill
           AND prior.source_intent_id = NEW.winner_source_intent_id
           AND prior.lifecycle_state = 'superseded'
           AND prior.superseded_by_agenda_item_id = NEW.winner_agenda_item_id
      )
    )
  )
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM secretary_agenda_preemption_dependencies AS dependency
       WHERE dependency.operation_id = NEW.operation_id
         AND dependency.state <> 'satisfied'
    ) OR NOT EXISTS (
      SELECT 1 FROM secretary_agenda_preemption_dependencies AS dependency
       WHERE dependency.operation_id = NEW.operation_id
    )
    THEN RAISE(ABORT, 'SECRETARY_PREEMPTION_DEPENDENCIES_PENDING')
    WHEN NEW.prior_winner_agenda_item_id IS NOT NULL
    THEN RAISE(ABORT, 'SECRETARY_PREEMPTION_PRIOR_WINNER_ACTIVE')
    ELSE RAISE(ABORT, 'SECRETARY_PREEMPTION_WINNER_NOT_READY')
  END AS preemption_guard;
END;

CREATE TRIGGER IF NOT EXISTS trg_secretary_preemption_operation_completed
BEFORE UPDATE OF state ON secretary_agenda_preemption_operations
FOR EACH ROW
WHEN NEW.state = 'completed'
  AND (
    EXISTS (
      SELECT 1 FROM secretary_agenda_preemption_dependencies AS dependency
       WHERE dependency.operation_id = NEW.operation_id
         AND dependency.state <> 'satisfied'
    )
    OR NOT EXISTS (
      SELECT 1
        FROM secretary_agenda_items AS winner
       WHERE winner.agenda_item_id = NEW.winner_agenda_item_id
         AND winner.version = NEW.winner_agenda_version
         AND winner.owner_user_id = NEW.owner_user_id
         AND winner.tenant_id = NEW.tenant_id
         AND winner.source_skill = NEW.winner_source_skill
         AND winner.source_intent_id = NEW.winner_source_intent_id
         AND winner.lifecycle_state = 'synced'
         AND winner.provider_sync_state = 'synced'
         AND winner.provider_target = NEW.winner_provider_target
         AND winner.provider_source = NEW.winner_provider_target
         AND winner.provider_event_id IS NOT NULL
         AND length(trim(winner.provider_event_id)) > 0
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'SECRETARY_PREEMPTION_WINNER_NOT_SYNCED');
END;

-- Cancellation is a request while provider cleanup is outstanding. The
-- terminal operation state is legal only after every exact loser delete is
-- settled and the proposed winner is durably canceled. An active prior
-- same-intent winner is deliberately left untouched.
CREATE TRIGGER IF NOT EXISTS trg_secretary_preemption_operation_canceled
BEFORE UPDATE OF state ON secretary_agenda_preemption_operations
FOR EACH ROW
WHEN NEW.state = 'canceled'
  AND (
    NOT EXISTS (
      SELECT 1 FROM secretary_agenda_preemption_dependencies AS dependency
       WHERE dependency.operation_id = NEW.operation_id
    )
    OR EXISTS (
      SELECT 1 FROM secretary_agenda_preemption_dependencies AS dependency
       WHERE dependency.operation_id = NEW.operation_id
         AND dependency.state <> 'satisfied'
    )
    OR NOT EXISTS (
      SELECT 1
        FROM secretary_agenda_items AS winner
       WHERE winner.agenda_item_id = NEW.winner_agenda_item_id
         AND winner.version = NEW.winner_agenda_version
         AND winner.owner_user_id = NEW.owner_user_id
         AND winner.tenant_id = NEW.tenant_id
         AND winner.source_skill = NEW.winner_source_skill
         AND winner.source_intent_id = NEW.winner_source_intent_id
         AND winner.lifecycle_state = 'canceled'
         AND winner.cancellation_reason IS NOT NULL
         AND winner.provider_event_id IS NULL
         AND winner.provider_source IS NULL
    )
    OR EXISTS (
      SELECT 1 FROM secretary_agenda_provider_sync_claims AS claim
       WHERE claim.owner_user_id = NEW.owner_user_id
         AND claim.tenant_id = NEW.tenant_id
         AND claim.agenda_item_id = NEW.winner_agenda_item_id
         AND claim.agenda_version = NEW.winner_agenda_version
         AND datetime(claim.lease_expires_at) > datetime('now')
    )
    OR EXISTS (
      SELECT 1 FROM secretary_agenda_provider_create_reconciliation AS attempt
       WHERE attempt.owner_user_id = NEW.owner_user_id
         AND attempt.tenant_id = NEW.tenant_id
         AND attempt.agenda_item_id = NEW.winner_agenda_item_id
         AND attempt.agenda_version = NEW.winner_agenda_version
         AND attempt.resolution_state IN ('in_flight', 'unknown', 'known')
    )
    OR EXISTS (
      SELECT 1 FROM secretary_agenda_provider_effect_recovery AS recovery
       WHERE recovery.owner_user_id = NEW.owner_user_id
         AND recovery.tenant_id = NEW.tenant_id
         AND recovery.agenda_item_id = NEW.winner_agenda_item_id
         AND recovery.agenda_version = NEW.winner_agenda_version
         AND recovery.resolution_state = 'pending'
    )
    OR (
      NEW.prior_winner_provider_event_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM secretary_agenda_items AS prior
         WHERE prior.agenda_item_id = NEW.prior_winner_agenda_item_id
           AND prior.version = NEW.prior_winner_agenda_version
           AND prior.owner_user_id = NEW.owner_user_id
           AND prior.tenant_id = NEW.tenant_id
           AND prior.provider_event_id IS NULL
           AND prior.provider_source IS NULL
           AND prior.provider_sync_state = 'deleted'
      )
    )
    OR EXISTS (
      SELECT 1 FROM secretary_agenda_provider_sync_claims AS claim
       WHERE claim.owner_user_id = NEW.owner_user_id
         AND claim.tenant_id = NEW.tenant_id
         AND claim.agenda_item_id = NEW.prior_winner_agenda_item_id
         AND claim.agenda_version = NEW.prior_winner_agenda_version
         AND datetime(claim.lease_expires_at) > datetime('now')
    )
    OR EXISTS (
      SELECT 1 FROM secretary_agenda_provider_effect_recovery AS recovery
       WHERE recovery.owner_user_id = NEW.owner_user_id
         AND recovery.tenant_id = NEW.tenant_id
         AND recovery.agenda_item_id = NEW.prior_winner_agenda_item_id
         AND recovery.agenda_version = NEW.prior_winner_agenda_version
         AND recovery.resolution_state = 'pending'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'SECRETARY_PREEMPTION_CANCELLATION_PENDING');
END;

-- Every edge freezes the exact loser rank and exact provider identity observed
-- by the Stage-1 planner. The active mapped vN and proposed unmapped vN+1 must
-- both still match when the edge is inserted.
CREATE TRIGGER IF NOT EXISTS trg_secretary_preemption_dependency_insert_guard
BEFORE INSERT ON secretary_agenda_preemption_dependencies
FOR EACH ROW
WHEN NEW.state <> 'pending'
  OR NEW.attempt_count <> 0
  OR NEW.lease_token IS NOT NULL
  OR NEW.lease_expires_at IS NOT NULL
  OR NEW.heartbeat_at IS NOT NULL
  OR NEW.failure_disposition IS NOT NULL
  OR NEW.failure_code IS NOT NULL
  OR NEW.retry_after_at IS NOT NULL
  OR NEW.provider_deleted_at IS NOT NULL
  OR NEW.satisfied_at IS NOT NULL
  OR NEW.last_checked_at IS NOT NULL
  OR NOT EXISTS (
    SELECT 1
      FROM secretary_agenda_preemption_operations AS operation
      JOIN secretary_agenda_items AS winner
        ON winner.agenda_item_id = operation.winner_agenda_item_id
       AND winner.version = operation.winner_agenda_version
       AND winner.owner_user_id = operation.owner_user_id
       AND winner.tenant_id = operation.tenant_id
      JOIN secretary_agenda_items AS loser
        ON loser.agenda_item_id = NEW.loser_agenda_item_id
       AND loser.version = NEW.loser_agenda_version
       AND loser.owner_user_id = NEW.owner_user_id
       AND loser.tenant_id = NEW.tenant_id
      JOIN secretary_agenda_items AS replacement
        ON replacement.agenda_item_id = NEW.loser_replacement_agenda_item_id
       AND replacement.version = NEW.loser_replacement_version
       AND replacement.owner_user_id = NEW.owner_user_id
       AND replacement.tenant_id = NEW.tenant_id
     WHERE operation.operation_id = NEW.operation_id
       AND operation.owner_user_id = NEW.owner_user_id
       AND operation.tenant_id = NEW.tenant_id
       AND operation.state = 'cleanup_pending'
       AND operation.arbitration_policy_version = NEW.loser_arbitration_policy_version
       AND operation.winner_source_skill <> NEW.loser_source_skill
       AND (
         winner.arbitration_score > NEW.loser_arbitration_score
         OR (
           winner.arbitration_score = NEW.loser_arbitration_score
           AND (
             (
               winner.arbitration_deadline_at IS NOT NULL
               AND NEW.loser_arbitration_deadline_at IS NULL
             )
             OR (
               winner.arbitration_deadline_at IS NOT NULL
               AND NEW.loser_arbitration_deadline_at IS NOT NULL
               AND datetime(winner.arbitration_deadline_at) < datetime(NEW.loser_arbitration_deadline_at)
             )
             OR (
               (
                 (winner.arbitration_deadline_at IS NULL AND NEW.loser_arbitration_deadline_at IS NULL)
                 OR (
                   winner.arbitration_deadline_at IS NOT NULL
                   AND NEW.loser_arbitration_deadline_at IS NOT NULL
                   AND datetime(winner.arbitration_deadline_at) = datetime(NEW.loser_arbitration_deadline_at)
                 )
               )
               AND winner.source_intent_id COLLATE BINARY < NEW.loser_source_intent_id COLLATE BINARY
             )
           )
         )
       )
       AND loser.source_skill = NEW.loser_source_skill
       AND loser.source_intent_id = NEW.loser_source_intent_id
       AND loser.source_shape_hash = NEW.loser_source_shape_hash
       AND loser.lifecycle_state IN ('scheduled', 'synced', 'reflowed', 'compressed', 'failed_sync')
       AND loser.provider_sync_state = 'synced'
       AND loser.provider_target = NEW.loser_provider_target
       AND loser.provider_source = NEW.loser_provider_source
       AND loser.provider_event_id = NEW.loser_provider_event_id
       AND loser.cancellation_reason IS NULL
       AND loser.superseded_by_agenda_item_id IS NULL
       AND loser.arbitration_score = NEW.loser_arbitration_score
       AND loser.arbitration_deadline_at IS NEW.loser_arbitration_deadline_at
       AND loser.arbitration_flexibility = NEW.loser_arbitration_flexibility
       AND loser.arbitration_policy_version = NEW.loser_arbitration_policy_version
       AND replacement.source_skill = NEW.loser_source_skill
       AND replacement.source_intent_id = NEW.loser_source_intent_id
       AND replacement.lifecycle_state = 'proposed'
       AND replacement.provider_sync_state = 'not_synced'
       AND replacement.provider_target = NEW.loser_provider_target
       AND replacement.provider_source IS NULL
       AND replacement.provider_event_id IS NULL
       AND replacement.cancellation_reason = 'priority_preemption_pending'
       AND replacement.superseded_by_agenda_item_id IS NULL
       AND datetime(loser.start_at) < datetime(winner.end_at)
       AND datetime(winner.start_at) < datetime(loser.end_at)
  )
BEGIN
  SELECT RAISE(ABORT, 'SECRETARY_PREEMPTION_DEPENDENCY_SCOPE_MISMATCH');
END;

CREATE TRIGGER IF NOT EXISTS trg_secretary_preemption_dependency_identity_immutable
BEFORE UPDATE ON secretary_agenda_preemption_dependencies
FOR EACH ROW
WHEN NEW.dependency_id IS NOT OLD.dependency_id
  OR NEW.operation_id IS NOT OLD.operation_id
  OR NEW.owner_user_id IS NOT OLD.owner_user_id
  OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.loser_agenda_item_id IS NOT OLD.loser_agenda_item_id
  OR NEW.loser_agenda_version IS NOT OLD.loser_agenda_version
  OR NEW.loser_replacement_agenda_item_id IS NOT OLD.loser_replacement_agenda_item_id
  OR NEW.loser_replacement_version IS NOT OLD.loser_replacement_version
  OR NEW.loser_source_skill IS NOT OLD.loser_source_skill
  OR NEW.loser_source_intent_id IS NOT OLD.loser_source_intent_id
  OR NEW.loser_source_shape_hash IS NOT OLD.loser_source_shape_hash
  OR NEW.loser_arbitration_score IS NOT OLD.loser_arbitration_score
  OR NEW.loser_arbitration_deadline_at IS NOT OLD.loser_arbitration_deadline_at
  OR NEW.loser_arbitration_flexibility IS NOT OLD.loser_arbitration_flexibility
  OR NEW.loser_arbitration_policy_version IS NOT OLD.loser_arbitration_policy_version
  OR NEW.loser_provider_target IS NOT OLD.loser_provider_target
  OR NEW.loser_provider_source IS NOT OLD.loser_provider_source
  OR NEW.loser_provider_event_id IS NOT OLD.loser_provider_event_id
  OR NEW.provider_identity_hash IS NOT OLD.provider_identity_hash
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'SECRETARY_PREEMPTION_DEPENDENCY_IDENTITY_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_secretary_preemption_dependency_state_transition
BEFORE UPDATE OF state ON secretary_agenda_preemption_dependencies
FOR EACH ROW
WHEN NEW.state IS NOT OLD.state
  AND NOT (
    (OLD.state IN ('pending', 'retryable', 'reconcile') AND NEW.state = 'in_progress')
    OR (OLD.state = 'in_progress' AND NEW.state IN ('retryable', 'reconcile', 'terminal', 'satisfied'))
  )
BEGIN
  SELECT RAISE(ABORT, 'SECRETARY_PREEMPTION_DEPENDENCY_STATE_INVALID');
END;

CREATE TRIGGER IF NOT EXISTS trg_secretary_preemption_dependency_lease_claim
BEFORE UPDATE OF state, lease_token, lease_expires_at, heartbeat_at, attempt_count
ON secretary_agenda_preemption_dependencies
FOR EACH ROW
WHEN NEW.state = 'in_progress'
  AND NOT (
    (
      OLD.state IN ('pending', 'retryable', 'reconcile')
      AND NEW.lease_token IS NOT NULL
      AND length(trim(NEW.lease_token)) > 0
      AND NEW.lease_token IS NOT OLD.lease_token
      AND datetime(NEW.lease_expires_at) > datetime('now')
      AND NEW.heartbeat_at IS NOT NULL
      AND NEW.attempt_count = OLD.attempt_count + 1
      AND NEW.failure_disposition IS NULL
      AND NEW.failure_code IS NULL
      AND NEW.retry_after_at IS NULL
    )
    OR (
      OLD.state = 'in_progress'
      AND datetime(OLD.lease_expires_at) <= datetime('now')
      AND NEW.lease_token IS NOT NULL
      AND NEW.lease_token IS NOT OLD.lease_token
      AND datetime(NEW.lease_expires_at) > datetime('now')
      AND NEW.heartbeat_at IS NOT NULL
      AND NEW.attempt_count = OLD.attempt_count + 1
    )
    OR (
      OLD.state = 'in_progress'
      AND NEW.lease_token = OLD.lease_token
      AND datetime(NEW.lease_expires_at) >= datetime(OLD.lease_expires_at)
      AND datetime(NEW.lease_expires_at) > datetime('now')
      AND NEW.heartbeat_at IS NOT NULL
      AND NEW.attempt_count = OLD.attempt_count
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'SECRETARY_PREEMPTION_LEASE_FENCE_VIOLATION');
END;

CREATE TRIGGER IF NOT EXISTS trg_secretary_preemption_dependency_lease_result
BEFORE UPDATE OF state ON secretary_agenda_preemption_dependencies
FOR EACH ROW
WHEN OLD.state = 'in_progress'
  AND NEW.state IN ('retryable', 'reconcile', 'terminal', 'satisfied')
  AND NOT (
    OLD.lease_token IS NOT NULL
    AND datetime(OLD.lease_expires_at) > datetime('now')
    AND NEW.lease_token IS NULL
    AND NEW.lease_expires_at IS NULL
    AND NEW.heartbeat_at IS NULL
    AND NEW.attempt_count = OLD.attempt_count
  )
BEGIN
  SELECT RAISE(ABORT, 'SECRETARY_PREEMPTION_LEASE_FENCE_VIOLATION');
END;

CREATE TRIGGER IF NOT EXISTS trg_secretary_preemption_dependency_settlement
BEFORE UPDATE OF state ON secretary_agenda_preemption_dependencies
FOR EACH ROW
WHEN NEW.state = 'satisfied'
  AND (
    NEW.provider_deleted_at IS NULL
    OR NEW.satisfied_at IS NULL
    OR NOT EXISTS (
      SELECT 1
        FROM secretary_agenda_items AS loser
        JOIN secretary_agenda_items AS replacement
          ON replacement.agenda_item_id = NEW.loser_replacement_agenda_item_id
         AND replacement.version = NEW.loser_replacement_version
         AND replacement.owner_user_id = NEW.owner_user_id
         AND replacement.tenant_id = NEW.tenant_id
       WHERE loser.agenda_item_id = NEW.loser_agenda_item_id
         AND loser.version = NEW.loser_agenda_version
         AND loser.owner_user_id = NEW.owner_user_id
         AND loser.tenant_id = NEW.tenant_id
         AND loser.source_skill = NEW.loser_source_skill
         AND loser.source_intent_id = NEW.loser_source_intent_id
         AND loser.lifecycle_state = 'superseded'
         AND loser.provider_sync_state = 'deleted'
         AND loser.provider_event_id IS NULL
         AND loser.provider_source IS NULL
         AND loser.provider_target = NEW.loser_provider_target
         AND loser.cancellation_reason = 'priority_preempted'
         AND loser.superseded_by_agenda_item_id = NEW.loser_replacement_agenda_item_id
         AND replacement.source_skill = NEW.loser_source_skill
         AND replacement.source_intent_id = NEW.loser_source_intent_id
         AND replacement.lifecycle_state = 'unscheduled'
         AND replacement.provider_sync_state = 'deleted'
         AND replacement.provider_event_id IS NULL
         AND replacement.provider_source IS NULL
         AND replacement.provider_target = NEW.loser_provider_target
         AND replacement.cancellation_reason = 'priority_preempted'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'SECRETARY_PREEMPTION_LOCAL_SETTLEMENT_REQUIRED');
END;

-- Migration-281 hardening. A pinned target cannot be changed or cleared on a
-- row, and a later logical-intent version may only inherit the same target.
-- A legacy NULL row may still be repaired to the already-pinned target.
CREATE TRIGGER IF NOT EXISTS trg_secretary_provider_target_row_immutable
BEFORE UPDATE OF provider_target ON secretary_agenda_items
FOR EACH ROW
WHEN OLD.provider_target IS NOT NULL
  AND NEW.provider_target IS NOT OLD.provider_target
BEGIN
  SELECT RAISE(ABORT, 'SECRETARY_PROVIDER_TARGET_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_secretary_provider_target_logical_insert
BEFORE INSERT ON secretary_agenda_items
FOR EACH ROW
WHEN NEW.provider_target IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM secretary_agenda_items AS existing
     WHERE existing.owner_user_id = NEW.owner_user_id
       AND existing.tenant_id = NEW.tenant_id
       AND existing.source_skill = NEW.source_skill
       AND existing.source_intent_id = NEW.source_intent_id
       AND existing.provider_target IS NOT NULL
       AND existing.provider_target <> NEW.provider_target
       AND (
         existing.provider_event_id IS NOT NULL
         OR existing.provider_source IS NOT NULL
         OR existing.provider_sync_state <> 'deleted'
         OR existing.lifecycle_state NOT IN ('canceled', 'superseded', 'unscheduled', 'deferred', 'completed')
         OR EXISTS (
           SELECT 1 FROM secretary_agenda_provider_sync_claims AS claim
            WHERE claim.owner_user_id = existing.owner_user_id
              AND claim.tenant_id = existing.tenant_id
              AND claim.agenda_item_id = existing.agenda_item_id
              AND claim.agenda_version = existing.version
              AND datetime(claim.lease_expires_at) > datetime('now')
         )
         OR EXISTS (
           SELECT 1 FROM secretary_agenda_provider_effect_recovery AS recovery
            WHERE recovery.owner_user_id = existing.owner_user_id
              AND recovery.tenant_id = existing.tenant_id
              AND recovery.agenda_item_id = existing.agenda_item_id
              AND recovery.agenda_version = existing.version
              AND recovery.resolution_state = 'pending'
         )
         OR EXISTS (
           SELECT 1 FROM secretary_agenda_preemption_operations AS operation
            WHERE operation.owner_user_id = existing.owner_user_id
              AND operation.tenant_id = existing.tenant_id
              AND operation.state NOT IN ('completed', 'canceled', 'terminal_failure')
              AND (
                (operation.winner_agenda_item_id = existing.agenda_item_id AND operation.winner_agenda_version = existing.version)
                OR (operation.prior_winner_agenda_item_id = existing.agenda_item_id AND operation.prior_winner_agenda_version = existing.version)
              )
         )
       )
  )
BEGIN
  SELECT RAISE(ABORT, 'SECRETARY_PROVIDER_TARGET_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_secretary_provider_target_logical_update
BEFORE UPDATE OF provider_target ON secretary_agenda_items
FOR EACH ROW
WHEN NEW.provider_target IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM secretary_agenda_items AS existing
     WHERE existing.agenda_item_id <> NEW.agenda_item_id
       AND existing.owner_user_id = NEW.owner_user_id
       AND existing.tenant_id = NEW.tenant_id
       AND existing.source_skill = NEW.source_skill
       AND existing.source_intent_id = NEW.source_intent_id
       AND existing.provider_target IS NOT NULL
       AND existing.provider_target <> NEW.provider_target
       AND (
         existing.provider_event_id IS NOT NULL
         OR existing.provider_source IS NOT NULL
         OR existing.provider_sync_state <> 'deleted'
         OR existing.lifecycle_state NOT IN ('canceled', 'superseded', 'unscheduled', 'deferred', 'completed')
         OR EXISTS (
           SELECT 1 FROM secretary_agenda_provider_sync_claims AS claim
            WHERE claim.owner_user_id = existing.owner_user_id
              AND claim.tenant_id = existing.tenant_id
              AND claim.agenda_item_id = existing.agenda_item_id
              AND claim.agenda_version = existing.version
              AND datetime(claim.lease_expires_at) > datetime('now')
         )
         OR EXISTS (
           SELECT 1 FROM secretary_agenda_provider_effect_recovery AS recovery
            WHERE recovery.owner_user_id = existing.owner_user_id
              AND recovery.tenant_id = existing.tenant_id
              AND recovery.agenda_item_id = existing.agenda_item_id
              AND recovery.agenda_version = existing.version
              AND recovery.resolution_state = 'pending'
         )
         OR EXISTS (
           SELECT 1 FROM secretary_agenda_preemption_operations AS operation
            WHERE operation.owner_user_id = existing.owner_user_id
              AND operation.tenant_id = existing.tenant_id
              AND operation.state NOT IN ('completed', 'canceled', 'terminal_failure')
              AND (
                (operation.winner_agenda_item_id = existing.agenda_item_id AND operation.winner_agenda_version = existing.version)
                OR (operation.prior_winner_agenda_item_id = existing.agenda_item_id AND operation.prior_winner_agenda_version = existing.version)
              )
         )
       )
  )
BEGIN
  SELECT RAISE(ABORT, 'SECRETARY_PROVIDER_TARGET_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_secretary_provider_source_target_insert
BEFORE INSERT ON secretary_agenda_items
FOR EACH ROW
WHEN NEW.provider_source IS NOT NULL
  AND (NEW.provider_target IS NULL OR NEW.provider_source <> NEW.provider_target)
BEGIN
  SELECT RAISE(ABORT, 'SECRETARY_PROVIDER_SOURCE_TARGET_MISMATCH');
END;

CREATE TRIGGER IF NOT EXISTS trg_secretary_provider_source_target_update
BEFORE UPDATE OF provider_source, provider_target ON secretary_agenda_items
FOR EACH ROW
WHEN NEW.provider_source IS NOT NULL
  AND (NEW.provider_target IS NULL OR NEW.provider_source <> NEW.provider_target)
BEGIN
  SELECT RAISE(ABORT, 'SECRETARY_PROVIDER_SOURCE_TARGET_MISMATCH');
END;

-- Defense in depth for mixed runtime versions: raw claims, create-attempt
-- rows, and mapping writes cannot cross the unresolved cleanup fence.
CREATE TRIGGER IF NOT EXISTS trg_secretary_preemption_provider_claim_insert_fence
BEFORE INSERT ON secretary_agenda_provider_sync_claims
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
    FROM secretary_agenda_preemption_operations AS operation
   WHERE operation.owner_user_id = NEW.owner_user_id
     AND operation.tenant_id = NEW.tenant_id
     AND operation.winner_agenda_item_id = NEW.agenda_item_id
     AND operation.winner_agenda_version = NEW.agenda_version
     AND operation.winner_source_skill = NEW.source_skill
     AND operation.winner_source_intent_id = NEW.source_intent_id
     AND (
       operation.winner_provider_target <> NEW.provider_source
       OR operation.state NOT IN ('winner_ready', 'winner_reconcile', 'completed')
       OR EXISTS (
         SELECT 1 FROM secretary_agenda_preemption_dependencies AS dependency
          WHERE dependency.operation_id = operation.operation_id
            AND dependency.state <> 'satisfied'
       )
     )
)
BEGIN
  SELECT RAISE(ABORT, 'SECRETARY_PREEMPTION_PROVIDER_DEPENDENCY_PENDING');
END;

CREATE TRIGGER IF NOT EXISTS trg_secretary_preemption_provider_claim_update_fence
BEFORE UPDATE ON secretary_agenda_provider_sync_claims
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
    FROM secretary_agenda_preemption_operations AS operation
   WHERE operation.owner_user_id = NEW.owner_user_id
     AND operation.tenant_id = NEW.tenant_id
     AND operation.winner_agenda_item_id = NEW.agenda_item_id
     AND operation.winner_agenda_version = NEW.agenda_version
     AND operation.winner_source_skill = NEW.source_skill
     AND operation.winner_source_intent_id = NEW.source_intent_id
     AND (
       operation.winner_provider_target <> NEW.provider_source
       OR operation.state NOT IN ('winner_ready', 'winner_reconcile', 'completed')
       OR EXISTS (
         SELECT 1 FROM secretary_agenda_preemption_dependencies AS dependency
          WHERE dependency.operation_id = operation.operation_id
            AND dependency.state <> 'satisfied'
       )
     )
)
BEGIN
  SELECT RAISE(ABORT, 'SECRETARY_PREEMPTION_PROVIDER_DEPENDENCY_PENDING');
END;

CREATE TRIGGER IF NOT EXISTS trg_secretary_preemption_create_attempt_insert_fence
BEFORE INSERT ON secretary_agenda_provider_create_reconciliation
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
    FROM secretary_agenda_preemption_operations AS operation
   WHERE operation.owner_user_id = NEW.owner_user_id
     AND operation.tenant_id = NEW.tenant_id
     AND operation.winner_agenda_item_id = NEW.agenda_item_id
     AND operation.winner_agenda_version = NEW.agenda_version
     AND operation.winner_source_skill = NEW.source_skill
     AND operation.winner_source_intent_id = NEW.source_intent_id
     AND (
       operation.winner_provider_target <> NEW.provider_source
       OR operation.cancel_requested_at IS NOT NULL
       OR operation.state NOT IN ('winner_ready', 'winner_reconcile', 'completed')
       OR EXISTS (
         SELECT 1 FROM secretary_agenda_preemption_dependencies AS dependency
          WHERE dependency.operation_id = operation.operation_id
            AND dependency.state <> 'satisfied'
       )
     )
)
BEGIN
  SELECT RAISE(ABORT, 'SECRETARY_PREEMPTION_PROVIDER_DEPENDENCY_PENDING');
END;

CREATE TRIGGER IF NOT EXISTS trg_secretary_preemption_create_attempt_update_fence
BEFORE UPDATE ON secretary_agenda_provider_create_reconciliation
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
    FROM secretary_agenda_preemption_operations AS operation
   WHERE operation.owner_user_id = NEW.owner_user_id
     AND operation.tenant_id = NEW.tenant_id
     AND operation.winner_agenda_item_id = NEW.agenda_item_id
     AND operation.winner_agenda_version = NEW.agenda_version
     AND operation.winner_source_skill = NEW.source_skill
     AND operation.winner_source_intent_id = NEW.source_intent_id
     AND (
       operation.winner_provider_target <> NEW.provider_source
       OR operation.state NOT IN ('winner_ready', 'winner_reconcile', 'completed')
       OR EXISTS (
         SELECT 1 FROM secretary_agenda_preemption_dependencies AS dependency
          WHERE dependency.operation_id = operation.operation_id
            AND dependency.state <> 'satisfied'
       )
     )
)
BEGIN
  SELECT RAISE(ABORT, 'SECRETARY_PREEMPTION_PROVIDER_DEPENDENCY_PENDING');
END;

-- Update/adopt effects know their exact provider id before the call. Their
-- durable recovery row must therefore be inserted through the live claim
-- before any external mutation can start. Creates use their separate
-- pre-effect attempt ledger because the provider id is not known yet.
CREATE TRIGGER IF NOT EXISTS trg_secretary_preemption_provider_effect_insert_fence
BEFORE INSERT ON secretary_agenda_provider_effect_recovery
FOR EACH ROW
WHEN NEW.effect_kind IN ('update', 'adopt')
  AND EXISTS (
    SELECT 1
      FROM secretary_agenda_preemption_operations AS operation
     WHERE operation.owner_user_id = NEW.owner_user_id
       AND operation.tenant_id = NEW.tenant_id
       AND operation.winner_agenda_item_id = NEW.agenda_item_id
       AND operation.winner_agenda_version = NEW.agenda_version
       AND (
         operation.winner_provider_target <> NEW.provider_source
         OR operation.cancel_requested_at IS NOT NULL
         OR operation.state NOT IN ('winner_ready', 'winner_reconcile', 'completed')
         OR EXISTS (
           SELECT 1 FROM secretary_agenda_preemption_dependencies AS dependency
            WHERE dependency.operation_id = operation.operation_id
              AND dependency.state <> 'satisfied'
         )
         OR NOT EXISTS (
           SELECT 1 FROM secretary_agenda_provider_sync_claims AS claim
            WHERE claim.owner_user_id = NEW.owner_user_id
              AND claim.tenant_id = NEW.tenant_id
              AND claim.provider_source = NEW.provider_source
              AND claim.source_skill = NEW.source_skill
              AND claim.source_intent_id = NEW.source_intent_id
              AND claim.agenda_item_id = NEW.agenda_item_id
              AND claim.agenda_version = NEW.agenda_version
              AND claim.desired_fingerprint = NEW.desired_fingerprint
              AND datetime(claim.lease_expires_at) > datetime('now')
         )
       )
  )
BEGIN
  SELECT RAISE(ABORT, 'SECRETARY_PREEMPTION_PROVIDER_DEPENDENCY_PENDING');
END;

CREATE TRIGGER IF NOT EXISTS trg_secretary_preemption_winner_mapping_fence
BEFORE UPDATE OF provider_event_id, provider_source, provider_sync_state
ON secretary_agenda_items
FOR EACH ROW
WHEN (
    NEW.provider_event_id IS NOT OLD.provider_event_id
    OR NEW.provider_source IS NOT OLD.provider_source
    OR NEW.provider_sync_state IS NOT OLD.provider_sync_state
  )
  AND EXISTS (
    SELECT 1
      FROM secretary_agenda_preemption_operations AS operation
     WHERE operation.owner_user_id = NEW.owner_user_id
       AND operation.tenant_id = NEW.tenant_id
       AND operation.winner_agenda_item_id = NEW.agenda_item_id
       AND operation.winner_agenda_version = NEW.version
       AND (
         (
           operation.cancel_requested_at IS NOT NULL
           AND (
             (OLD.provider_event_id IS NULL AND NEW.provider_event_id IS NOT NULL)
             OR (OLD.provider_source IS NULL AND NEW.provider_source IS NOT NULL)
             OR NEW.provider_sync_state = 'synced'
           )
         )
         OR
         operation.state NOT IN ('winner_ready', 'winner_reconcile', 'completed')
         OR EXISTS (
           SELECT 1 FROM secretary_agenda_preemption_dependencies AS dependency
            WHERE dependency.operation_id = operation.operation_id
              AND dependency.state <> 'satisfied'
         )
       )
  )
BEGIN
  SELECT RAISE(ABORT, 'SECRETARY_PREEMPTION_PROVIDER_DEPENDENCY_PENDING');
END;

-- Generic Cooking/Finance/Content feedback becomes the same monotonic current
-- intent projection as migration 276's Training sink.
ALTER TABLE secretary_source_skill_feedback
  ADD COLUMN agenda_version INTEGER NOT NULL DEFAULT 1
    CHECK (agenda_version > 0);

UPDATE secretary_source_skill_feedback
SET agenda_version = COALESCE((
  SELECT agenda.version
    FROM secretary_agenda_items AS agenda
   WHERE agenda.agenda_item_id = secretary_source_skill_feedback.agenda_item_id
     AND agenda.owner_user_id = secretary_source_skill_feedback.user_id
     AND agenda.tenant_id = secretary_source_skill_feedback.tenant_id
     AND agenda.source_skill = secretary_source_skill_feedback.target_skill
     AND agenda.source_intent_id = secretary_source_skill_feedback.source_intent_id
), 1);

DELETE FROM secretary_source_skill_feedback
WHERE EXISTS (
  SELECT 1
    FROM secretary_source_skill_feedback AS newer
   WHERE newer.user_id = secretary_source_skill_feedback.user_id
     AND newer.tenant_id = secretary_source_skill_feedback.tenant_id
     AND newer.target_skill = secretary_source_skill_feedback.target_skill
     AND newer.source_intent_id = secretary_source_skill_feedback.source_intent_id
     AND (
       newer.agenda_version > secretary_source_skill_feedback.agenda_version
       OR (
         newer.agenda_version = secretary_source_skill_feedback.agenda_version
         AND (
           COALESCE(julianday(newer.updated_at), 0) > COALESCE(julianday(secretary_source_skill_feedback.updated_at), 0)
           OR (
             COALESCE(julianday(newer.updated_at), 0) = COALESCE(julianday(secretary_source_skill_feedback.updated_at), 0)
             AND newer.id > secretary_source_skill_feedback.id
           )
         )
       )
     )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_secretary_source_skill_feedback_current_intent
  ON secretary_source_skill_feedback(user_id, tenant_id, target_skill, source_intent_id);

CREATE INDEX IF NOT EXISTS idx_secretary_source_skill_feedback_scope_version
  ON secretary_source_skill_feedback(
    user_id, tenant_id, target_skill, agenda_version DESC, updated_at DESC
  );
