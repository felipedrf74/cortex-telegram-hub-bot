-- Migration 244: canonical Content work scheduling through Secretary.
-- A preview is non-persisting in Secretary; only explicit confirmation creates
-- a Secretary agenda binding. Publication execution is intentionally outside
-- this model and remains `not_performed`.

-- Own the composite parent keys used by this migration. They intentionally do
-- not depend on the agent-job migration keeping identically shaped indexes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_artifacts_schedule_scope
  ON content_artifacts(id, tenant_id, owner_user_id, item_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_revisions_schedule_scope
  ON content_revisions(id, tenant_id, owner_user_id, artifact_id);

CREATE TABLE IF NOT EXISTS content_schedule_previews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  preview_key TEXT NOT NULL UNIQUE CHECK (length(trim(preview_key)) > 0),
  tenant_id INTEGER NOT NULL,
  owner_user_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  artifact_id INTEGER NOT NULL,
  revision_id INTEGER NOT NULL,
  base_revision_number INTEGER NOT NULL CHECK (base_revision_number >= 1),
  base_content_hash TEXT NOT NULL CHECK (length(base_content_hash) = 64),
  base_workflow_version INTEGER NOT NULL CHECK (base_workflow_version >= 1),
  work_kind TEXT NOT NULL CHECK (work_kind IN ('write', 'revise', 'record', 'edit', 'review', 'publish_prep')),
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 15 AND 480),
  preferred_windows_json TEXT NOT NULL CHECK (
    json_valid(preferred_windows_json)
    AND json_type(preferred_windows_json) = 'array'
    AND json_array_length(preferred_windows_json) BETWEEN 1 AND 10
  ),
  deadline_at TEXT CHECK (deadline_at IS NULL OR julianday(deadline_at) IS NOT NULL),
  priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  title_disclosure TEXT NOT NULL CHECK (title_disclosure IN ('generic', 'content_title')),
  visible_title TEXT NOT NULL CHECK (length(trim(visible_title)) BETWEEN 1 AND 200),
  context_shared_json TEXT NOT NULL CHECK (
    json_valid(context_shared_json) AND json_type(context_shared_json) = 'array'
  ),
  intent_json TEXT NOT NULL CHECK (json_valid(intent_json) AND json_type(intent_json) = 'object'),
  preview_result_json TEXT NOT NULL CHECK (
    json_valid(preview_result_json) AND json_type(preview_result_json) = 'object'
  ),
  preview_fingerprint TEXT NOT NULL CHECK (length(preview_fingerprint) = 64),
  status TEXT NOT NULL CHECK (status IN ('previewed', 'unavailable', 'submitting', 'confirmed', 'failed', 'stale', 'expired')),
  create_idempotency_key TEXT NOT NULL CHECK (length(trim(create_idempotency_key)) > 0),
  create_request_hash TEXT NOT NULL CHECK (length(create_request_hash) = 64),
  confirmation_idempotency_key TEXT,
  confirmation_request_hash TEXT CHECK (confirmation_request_hash IS NULL OR length(confirmation_request_hash) = 64),
  secretary_source_intent_id TEXT NOT NULL CHECK (length(trim(secretary_source_intent_id)) > 0),
  secretary_agenda_item_id TEXT CHECK (
    secretary_agenda_item_id IS NULL OR length(trim(secretary_agenda_item_id)) > 0
  ),
  last_error_code TEXT,
  expires_at TEXT NOT NULL CHECK (julianday(expires_at) IS NOT NULL),
  confirmed_at TEXT CHECK (confirmed_at IS NULL OR julianday(confirmed_at) IS NOT NULL),
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (confirmation_idempotency_key IS NULL AND confirmation_request_hash IS NULL)
    OR
    (
      confirmation_idempotency_key IS NOT NULL
      AND length(trim(confirmation_idempotency_key)) > 0
      AND confirmation_request_hash IS NOT NULL
    )
  ),
  CHECK (
    (status = 'confirmed' AND secretary_agenda_item_id IS NOT NULL AND confirmed_at IS NOT NULL)
    OR
    (status <> 'confirmed' AND confirmed_at IS NULL)
  ),
  UNIQUE (tenant_id, owner_user_id, create_idempotency_key),
  UNIQUE (tenant_id, owner_user_id, confirmation_idempotency_key),
  FOREIGN KEY (item_id, tenant_id, owner_user_id)
    REFERENCES content_domain_objects(id, tenant_id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (artifact_id, tenant_id, owner_user_id, item_id)
    REFERENCES content_artifacts(id, tenant_id, owner_user_id, item_id) ON DELETE CASCADE,
  FOREIGN KEY (revision_id, tenant_id, owner_user_id, artifact_id)
    REFERENCES content_revisions(id, tenant_id, owner_user_id, artifact_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_schedule_previews_binding_scope
  ON content_schedule_previews(
    id, tenant_id, owner_user_id, item_id, artifact_id, revision_id,
    base_revision_number, base_workflow_version,
    secretary_source_intent_id, secretary_agenda_item_id
  );

CREATE INDEX IF NOT EXISTS idx_content_schedule_previews_item
  ON content_schedule_previews(tenant_id, owner_user_id, item_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_content_schedule_previews_initial_status
BEFORE INSERT ON content_schedule_previews
WHEN NEW.status NOT IN ('previewed', 'unavailable')
BEGIN
  SELECT RAISE(ABORT, 'invalid initial content schedule preview status');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_schedule_previews_current_pin
BEFORE INSERT ON content_schedule_previews
WHEN NOT EXISTS (
  SELECT 1
    FROM content_domain_objects item
    JOIN content_artifacts artifact
      ON artifact.id = NEW.artifact_id
     AND artifact.tenant_id = NEW.tenant_id
     AND artifact.owner_user_id = NEW.owner_user_id
     AND artifact.item_id = item.id
    JOIN content_revisions revision
      ON revision.id = NEW.revision_id
     AND revision.tenant_id = NEW.tenant_id
     AND revision.owner_user_id = NEW.owner_user_id
     AND revision.artifact_id = artifact.id
   WHERE item.id = NEW.item_id
     AND item.tenant_id = NEW.tenant_id
     AND item.owner_user_id = NEW.owner_user_id
     AND item.scope_status = 'active'
     AND item.deleted_at IS NULL
     AND artifact.scope_status = 'active'
     AND artifact.current_revision_id = revision.id
     AND revision.revision_number = NEW.base_revision_number
     AND revision.content_hash = NEW.base_content_hash
     AND item.workflow_version = NEW.base_workflow_version
)
BEGIN
  SELECT RAISE(ABORT, 'content schedule preview pin is stale or out of scope');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_schedule_previews_immutable_input
BEFORE UPDATE OF
  preview_key, tenant_id, owner_user_id, item_id, artifact_id, revision_id,
  base_revision_number, base_content_hash, base_workflow_version, work_kind,
  duration_minutes, preferred_windows_json, deadline_at, priority,
  title_disclosure, visible_title, context_shared_json, intent_json,
  preview_result_json, preview_fingerprint, create_idempotency_key,
  create_request_hash, secretary_source_intent_id, expires_at, created_by, created_at
ON content_schedule_previews
BEGIN
  SELECT RAISE(ABORT, 'content schedule preview inputs are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_schedule_previews_immutable_confirmation
BEFORE UPDATE OF
  confirmation_idempotency_key, confirmation_request_hash,
  secretary_agenda_item_id, confirmed_at
ON content_schedule_previews
WHEN (
  OLD.confirmation_idempotency_key IS NOT NULL
  AND (
    NEW.confirmation_idempotency_key IS NOT OLD.confirmation_idempotency_key
    OR NEW.confirmation_request_hash IS NOT OLD.confirmation_request_hash
  )
) OR (
  OLD.secretary_agenda_item_id IS NOT NULL
  AND OLD.status = 'confirmed'
  AND NEW.secretary_agenda_item_id IS NOT OLD.secretary_agenda_item_id
) OR (
  OLD.confirmed_at IS NOT NULL
  AND NEW.confirmed_at IS NOT OLD.confirmed_at
)
BEGIN
  SELECT RAISE(ABORT, 'content schedule preview confirmation is immutable once recorded');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_schedule_previews_legal_status
BEFORE UPDATE OF status ON content_schedule_previews
WHEN OLD.status <> NEW.status
 AND NOT (
   (OLD.status = 'previewed' AND NEW.status IN ('submitting', 'expired', 'stale'))
   OR (OLD.status = 'unavailable' AND NEW.status IN ('expired', 'stale'))
   OR (OLD.status = 'submitting' AND NEW.status IN ('confirmed', 'failed', 'stale'))
   OR (OLD.status = 'failed' AND NEW.status IN ('submitting', 'expired', 'stale'))
 )
BEGIN
  SELECT RAISE(ABORT, 'invalid content schedule preview status transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_schedule_previews_submit_identity
BEFORE UPDATE OF status ON content_schedule_previews
WHEN NEW.status = 'submitting'
 AND (
   NEW.confirmation_idempotency_key IS NULL
   OR NEW.confirmation_request_hash IS NULL
 )
BEGIN
  SELECT RAISE(ABORT, 'content schedule confirmation identity is required');
END;

CREATE TABLE IF NOT EXISTS content_schedule_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  owner_user_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  artifact_id INTEGER NOT NULL,
  revision_id INTEGER NOT NULL,
  base_revision_number INTEGER NOT NULL CHECK (base_revision_number >= 1),
  base_workflow_version INTEGER NOT NULL CHECK (base_workflow_version >= 1),
  preview_id INTEGER NOT NULL UNIQUE,
  secretary_agenda_item_id TEXT NOT NULL CHECK (length(trim(secretary_agenda_item_id)) > 0),
  secretary_source_intent_id TEXT NOT NULL CHECK (length(trim(secretary_source_intent_id)) > 0),
  state TEXT NOT NULL CHECK (state IN (
    'scheduled', 'provider_synced', 'sync_failed', 'cancel_pending',
    'cancel_failed', 'cancelled', 'completed', 'stale'
  )),
  scheduled_start_at TEXT NOT NULL,
  scheduled_end_at TEXT NOT NULL,
  visible_title TEXT NOT NULL CHECK (length(trim(visible_title)) BETWEEN 1 AND 200),
  title_disclosure TEXT NOT NULL CHECK (title_disclosure IN ('generic', 'content_title')),
  context_shared_json TEXT NOT NULL CHECK (
    json_valid(context_shared_json) AND json_type(context_shared_json) = 'array'
  ),
  provider_sync_state TEXT NOT NULL CHECK (provider_sync_state IN (
    'not_synced', 'synced', 'create_failed', 'update_failed',
    'delete_failed', 'readback_failed', 'deleted'
  )),
  publication_execution TEXT NOT NULL DEFAULT 'not_performed'
    CHECK (publication_execution = 'not_performed'),
  cancellation_idempotency_key TEXT,
  cancellation_request_hash TEXT CHECK (cancellation_request_hash IS NULL OR length(cancellation_request_hash) = 64),
  last_error_code TEXT,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_at TEXT CHECK (cancelled_at IS NULL OR julianday(cancelled_at) IS NOT NULL),
  CHECK (
    julianday(scheduled_start_at) IS NOT NULL
    AND julianday(scheduled_end_at) IS NOT NULL
    AND julianday(scheduled_end_at) > julianday(scheduled_start_at)
  ),
  CHECK (
    (cancellation_idempotency_key IS NULL AND cancellation_request_hash IS NULL)
    OR
    (
      cancellation_idempotency_key IS NOT NULL
      AND length(trim(cancellation_idempotency_key)) > 0
      AND cancellation_request_hash IS NOT NULL
    )
  ),
  CHECK (state <> 'provider_synced' OR provider_sync_state = 'synced'),
  CHECK (state <> 'sync_failed' OR provider_sync_state IN ('create_failed', 'update_failed', 'readback_failed')),
  CHECK (state <> 'cancelled' OR provider_sync_state IN ('not_synced', 'deleted')),
  CHECK (
    state NOT IN ('cancel_pending', 'cancel_failed', 'cancelled')
    OR (cancellation_idempotency_key IS NOT NULL AND cancellation_request_hash IS NOT NULL)
  ),
  CHECK ((state = 'cancelled' AND cancelled_at IS NOT NULL) OR (state <> 'cancelled' AND cancelled_at IS NULL)),
  UNIQUE (tenant_id, owner_user_id, secretary_agenda_item_id),
  UNIQUE (tenant_id, owner_user_id, secretary_source_intent_id),
  UNIQUE (tenant_id, owner_user_id, cancellation_idempotency_key),
  FOREIGN KEY (
    preview_id, tenant_id, owner_user_id, item_id, artifact_id, revision_id,
    base_revision_number, base_workflow_version,
    secretary_source_intent_id, secretary_agenda_item_id
  ) REFERENCES content_schedule_previews(
    id, tenant_id, owner_user_id, item_id, artifact_id, revision_id,
    base_revision_number, base_workflow_version,
    secretary_source_intent_id, secretary_agenda_item_id
  ) ON DELETE NO ACTION,
  FOREIGN KEY (item_id, tenant_id, owner_user_id)
    REFERENCES content_domain_objects(id, tenant_id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (artifact_id, tenant_id, owner_user_id, item_id)
    REFERENCES content_artifacts(id, tenant_id, owner_user_id, item_id) ON DELETE CASCADE,
  FOREIGN KEY (revision_id, tenant_id, owner_user_id, artifact_id)
    REFERENCES content_revisions(id, tenant_id, owner_user_id, artifact_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_content_schedule_bindings_active_item
  ON content_schedule_bindings(tenant_id, owner_user_id, item_id)
  WHERE state IN (
    'scheduled', 'provider_synced', 'sync_failed', 'cancel_pending', 'cancel_failed'
  );

CREATE INDEX IF NOT EXISTS idx_content_schedule_bindings_item
  ON content_schedule_bindings(tenant_id, owner_user_id, item_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_content_schedule_bindings_initial_state
BEFORE INSERT ON content_schedule_bindings
WHEN NEW.state <> 'scheduled'
BEGIN
  SELECT RAISE(ABORT, 'invalid initial content schedule binding state');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_schedule_bindings_current_pin
BEFORE INSERT ON content_schedule_bindings
WHEN NOT EXISTS (
  SELECT 1
    FROM content_domain_objects item
    JOIN content_artifacts artifact
      ON artifact.id = NEW.artifact_id
     AND artifact.tenant_id = NEW.tenant_id
     AND artifact.owner_user_id = NEW.owner_user_id
     AND artifact.item_id = item.id
    JOIN content_revisions revision
      ON revision.id = NEW.revision_id
     AND revision.tenant_id = NEW.tenant_id
     AND revision.owner_user_id = NEW.owner_user_id
     AND revision.artifact_id = artifact.id
   WHERE item.id = NEW.item_id
     AND item.tenant_id = NEW.tenant_id
     AND item.owner_user_id = NEW.owner_user_id
     AND item.scope_status = 'active'
     AND item.deleted_at IS NULL
     AND artifact.scope_status = 'active'
     AND artifact.current_revision_id = revision.id
     AND revision.revision_number = NEW.base_revision_number
     AND item.workflow_version = NEW.base_workflow_version
)
BEGIN
  SELECT RAISE(ABORT, 'content schedule binding pin is stale or out of scope');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_schedule_bindings_secretary_scope
BEFORE INSERT ON content_schedule_bindings
WHEN NOT EXISTS (
  SELECT 1
    FROM secretary_agenda_items agenda
   WHERE agenda.agenda_item_id = NEW.secretary_agenda_item_id
     AND agenda.source_intent_id = NEW.secretary_source_intent_id
     AND agenda.source_skill = 'content'
     AND agenda.owner_user_id = NEW.owner_user_id
     AND agenda.tenant_id = CAST(NEW.tenant_id AS TEXT)
     AND agenda.lifecycle_state IN (
       'scheduled', 'synced', 'reflowed', 'compressed', 'failed_sync'
     )
     AND agenda.start_at = NEW.scheduled_start_at
     AND agenda.end_at = NEW.scheduled_end_at
     AND agenda.title = NEW.visible_title
     AND agenda.provider_sync_state = NEW.provider_sync_state
)
BEGIN
  SELECT RAISE(ABORT, 'content schedule binding Secretary scope mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_schedule_bindings_preview_state
BEFORE INSERT ON content_schedule_bindings
WHEN NOT EXISTS (
  SELECT 1
    FROM content_schedule_previews preview
   WHERE preview.id = NEW.preview_id
     AND preview.tenant_id = NEW.tenant_id
     AND preview.owner_user_id = NEW.owner_user_id
     AND preview.status = 'submitting'
     AND preview.confirmation_idempotency_key IS NOT NULL
     AND preview.confirmation_request_hash IS NOT NULL
     AND preview.visible_title = NEW.visible_title
     AND preview.title_disclosure = NEW.title_disclosure
     AND preview.context_shared_json = NEW.context_shared_json
)
BEGIN
  SELECT RAISE(ABORT, 'content schedule preview is not being confirmed');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_schedule_bindings_immutable_input
BEFORE UPDATE OF
  tenant_id, owner_user_id, item_id, artifact_id, revision_id,
  base_revision_number, base_workflow_version, preview_id,
  secretary_agenda_item_id, secretary_source_intent_id,
  scheduled_start_at, scheduled_end_at, visible_title, title_disclosure,
  context_shared_json, publication_execution, created_by, created_at
ON content_schedule_bindings
BEGIN
  SELECT RAISE(ABORT, 'content schedule binding inputs are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_schedule_bindings_immutable_cancellation
BEFORE UPDATE OF cancellation_idempotency_key, cancellation_request_hash, cancelled_at
ON content_schedule_bindings
WHEN (
  OLD.cancellation_idempotency_key IS NOT NULL
  AND (
    NEW.cancellation_idempotency_key IS NOT OLD.cancellation_idempotency_key
    OR NEW.cancellation_request_hash IS NOT OLD.cancellation_request_hash
  )
) OR (
  OLD.cancelled_at IS NOT NULL
  AND NEW.cancelled_at IS NOT OLD.cancelled_at
)
BEGIN
  SELECT RAISE(ABORT, 'content schedule binding cancellation is immutable once recorded');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_schedule_bindings_legal_state
BEFORE UPDATE OF state ON content_schedule_bindings
WHEN OLD.state <> NEW.state
 AND NOT (
   (OLD.state = 'scheduled' AND NEW.state IN ('provider_synced', 'sync_failed', 'cancel_pending', 'cancelled', 'completed', 'stale'))
   OR (OLD.state = 'provider_synced' AND NEW.state IN ('sync_failed', 'cancel_pending', 'cancelled', 'completed', 'stale'))
   OR (OLD.state = 'sync_failed' AND NEW.state IN ('provider_synced', 'cancel_pending', 'cancelled', 'completed', 'stale'))
   OR (OLD.state = 'cancel_pending' AND NEW.state IN ('cancelled', 'cancel_failed'))
   OR (OLD.state = 'cancel_failed' AND NEW.state IN ('cancel_pending', 'cancelled'))
 )
BEGIN
  SELECT RAISE(ABORT, 'invalid content schedule binding state transition');
END;

-- Confirmation is only terminal once the matching durable binding exists.
-- The intended transaction order is: record agenda id while submitting,
-- insert binding, then transition the preview to confirmed.
CREATE TRIGGER IF NOT EXISTS trg_content_schedule_previews_confirmed_binding
BEFORE UPDATE OF status ON content_schedule_previews
WHEN NEW.status = 'confirmed'
 AND NOT EXISTS (
   SELECT 1
     FROM content_schedule_bindings binding
    WHERE binding.preview_id = NEW.id
      AND binding.tenant_id = NEW.tenant_id
      AND binding.owner_user_id = NEW.owner_user_id
      AND binding.secretary_agenda_item_id = NEW.secretary_agenda_item_id
      AND binding.secretary_source_intent_id = NEW.secretary_source_intent_id
 )
BEGIN
  SELECT RAISE(ABORT, 'content schedule preview cannot confirm without its binding');
END;
