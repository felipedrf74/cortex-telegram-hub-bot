-- Migration 247: retire content_topics as a writable Content root.
--
-- Existing private topic rows are imported into the canonical Content
-- workspace. The compatibility link preserves the legacy numeric API id and
-- the minimum read-only Secretary evidence needed by old clients. New writes
-- are made only through content_domain_objects/content_artifacts/revisions.
-- Database triggers deliberately fail legacy writers after this migration so
-- a code-only rollback cannot create split-brain topic data. Rollback requires
-- the exact pre-migration database snapshot.

CREATE TABLE IF NOT EXISTS content_topic_workspace_links (
  compat_topic_id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  owner_user_id INTEGER NOT NULL,
  workspace_item_id INTEGER NOT NULL,
  compatibility_artifact_id INTEGER NOT NULL,
  legacy_topic_id INTEGER,
  origin TEXT NOT NULL CHECK (origin IN ('legacy_backfill', 'compatibility_create')),
  legacy_snapshot_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(legacy_snapshot_json) AND json_type(legacy_snapshot_json) = 'object'),
  legacy_schedule_retired_at TEXT
    CHECK (legacy_schedule_retired_at IS NULL OR julianday(legacy_schedule_retired_at) IS NOT NULL),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (origin = 'legacy_backfill' AND legacy_topic_id IS NOT NULL)
    OR (origin = 'compatibility_create' AND legacy_topic_id IS NULL)
  ),
  UNIQUE (tenant_id, owner_user_id, workspace_item_id),
  UNIQUE (tenant_id, owner_user_id, compatibility_artifact_id),
  UNIQUE (tenant_id, owner_user_id, legacy_topic_id),
  FOREIGN KEY (workspace_item_id, tenant_id, owner_user_id)
    REFERENCES content_domain_objects(id, tenant_id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (compatibility_artifact_id, tenant_id, owner_user_id, workspace_item_id)
    REFERENCES content_artifacts(id, tenant_id, owner_user_id, item_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_content_topic_workspace_links_scope
  ON content_topic_workspace_links(tenant_id, owner_user_id, compat_topic_id);

-- Allocate stable canonical identities once. The temporary plan makes the
-- item/artifact/link inserts deterministic inside the migration transaction.
CREATE TEMP TABLE temp_content_topic_workspace_plan AS
SELECT
  topic.id AS compat_topic_id,
  topic.id AS legacy_topic_id,
  topic.status AS legacy_status,
  topic.tenant_id,
  topic.owner_user_id,
  item_ids.max_id + ROW_NUMBER() OVER (ORDER BY topic.id) AS workspace_item_id,
  artifact_ids.max_id + ROW_NUMBER() OVER (ORDER BY topic.id) AS compatibility_artifact_id,
  CASE
    WHEN length(trim(topic.title)) > 0 THEN trim(topic.title)
    ELSE 'Untitled idea'
  END AS canonical_title,
  topic.notes AS canonical_summary,
  CASE
    WHEN julianday(topic.scheduled_at) IS NOT NULL THEN topic.scheduled_at
    WHEN julianday(topic.scheduled_date) IS NOT NULL THEN topic.scheduled_date
    ELSE NULL
  END AS canonical_deadline_at,
  CASE topic.status
    WHEN 'planned' THEN 'inbox'
    WHEN 'drafting' THEN 'active'
    WHEN 'ready' THEN 'active'
    -- A legacy status is a historical user claim, not reconstructable
    -- approval/publication evidence. Preserve the claim below but require
    -- review before canonical publication truth can exist.
    WHEN 'published' THEN 'review'
    WHEN 'cancelled' THEN 'archived'
    ELSE 'inbox'
  END AS canonical_production_state,
  CASE topic.status
    WHEN 'drafting' THEN 'draft'
    WHEN 'ready' THEN 'final'
    WHEN 'published' THEN 'final'
    ELSE 'idea'
  END AS canonical_artifact_phase,
  CASE topic.status
    WHEN 'drafting' THEN 'drafted'
    WHEN 'ready' THEN 'drafted'
    WHEN 'published' THEN 'review'
    WHEN 'cancelled' THEN 'archived'
    ELSE 'idea'
  END AS canonical_editorial_state,
  COALESCE(topic.created_at, datetime('now')) AS canonical_created_at,
  COALESCE(topic.updated_at, topic.created_at, datetime('now')) AS canonical_updated_at,
  json_object(
    'title', topic.title,
    'notes', topic.notes,
    'status', topic.status,
    'scheduledDate', topic.scheduled_date,
    'scheduledAt', topic.scheduled_at,
    'secretaryTaskListId', topic.secretary_task_list_id,
    'secretaryTaskListName', topic.secretary_task_list_name,
    'secretaryTaskExternalId', topic.secretary_task_external_id,
    'calendarEventId', topic.calendar_event_id,
    'calendarSource', topic.calendar_source,
    'secretarySyncStatus', topic.secretary_sync_status,
    'secretarySyncError', topic.secretary_sync_error,
    'sourceIds', CASE WHEN json_valid(topic.source_ids_json) THEN json(topic.source_ids_json) ELSE json('[]') END,
    'ontologySchemaVersion', topic.ontology_schema_version
  ) AS legacy_snapshot_json
FROM content_topics topic
CROSS JOIN (SELECT COALESCE(MAX(id), 0) AS max_id FROM content_domain_objects) item_ids
CROSS JOIN (SELECT COALESCE(MAX(id), 0) AS max_id FROM content_artifacts) artifact_ids
WHERE topic.user_id > 0
  AND topic.tenant_id = topic.user_id
  AND topic.owner_user_id = topic.user_id
  AND topic.visibility_scope = 'user_private'
  AND COALESCE(topic.scope_status, 'active') = 'active'
  AND NOT EXISTS (
    SELECT 1
      FROM content_topic_workspace_links link
     WHERE link.legacy_topic_id = topic.id
       AND link.tenant_id = topic.tenant_id
       AND link.owner_user_id = topic.owner_user_id
  );

INSERT INTO content_domain_objects (
  id, tenant_id, owner_user_id, visibility_scope, scope_status,
  object_type, lifecycle_state, production_state, artifact_phase,
  title, summary, deadline_at, current_artifact_id,
  editorial_state, approval_state, review_required,
  ontology_metadata_json, ontology_schema_version,
  workspace_schema_version, created_by, updated_by,
  audit_metadata_json, created_at, updated_at
)
SELECT
  plan.workspace_item_id,
  plan.tenant_id,
  plan.owner_user_id,
  'user_private',
  'active',
  'content_item',
  plan.canonical_production_state,
  plan.canonical_production_state,
  plan.canonical_artifact_phase,
  plan.canonical_title,
  plan.canonical_summary,
  plan.canonical_deadline_at,
  plan.compatibility_artifact_id,
  plan.canonical_editorial_state,
  CASE WHEN plan.legacy_status = 'published' THEN 'required' ELSE 'not_required' END,
  CASE WHEN plan.legacy_status = 'published' THEN 1 ELSE 0 END,
  json_object(
    'migration', 'content_topics_workspace_exit_v1',
    'reasonCodes', CASE
      WHEN plan.legacy_status = 'published'
      THEN json_array('legacy_publication_claim_requires_verification')
      ELSE json('[]')
    END
  ),
  'content-ontology-v1',
  'content-workspace-v1',
  plan.owner_user_id,
  plan.owner_user_id,
  json_object(
    'migration', json_object(
      'source', 'content_topics',
      'legacyTopicId', plan.legacy_topic_id,
      'compatTopicId', plan.compat_topic_id,
      'migrationVersion', 247,
      'legacyStatusClaim', plan.legacy_status,
      'reasonCodes', CASE
        WHEN plan.legacy_status = 'published'
        THEN json_array('legacy_publication_claim_requires_verification')
        ELSE json('[]')
      END
    )
  ),
  plan.canonical_created_at,
  plan.canonical_updated_at
FROM temp_content_topic_workspace_plan plan;

INSERT INTO content_artifacts (
  id, tenant_id, owner_user_id, visibility_scope, scope_status,
  item_id, artifact_type, title, metadata_json, schema_version,
  created_by, updated_by, created_at, updated_at
)
SELECT
  plan.compatibility_artifact_id,
  plan.tenant_id,
  plan.owner_user_id,
  'user_private',
  'active',
  plan.workspace_item_id,
  'idea_note',
  plan.canonical_title,
  json_object(
    'compatibility', 'legacy_content_topic',
    'legacyTopicId', plan.legacy_topic_id,
    'revisionState', 'migration_snapshot_only'
  ),
  'content-artifact-v1',
  plan.owner_user_id,
  plan.owner_user_id,
  plan.canonical_created_at,
  plan.canonical_updated_at
FROM temp_content_topic_workspace_plan plan;

INSERT INTO content_topic_workspace_links (
  compat_topic_id, tenant_id, owner_user_id, workspace_item_id,
  compatibility_artifact_id, legacy_topic_id, origin,
  legacy_snapshot_json, created_at, updated_at
)
SELECT
  plan.compat_topic_id,
  plan.tenant_id,
  plan.owner_user_id,
  plan.workspace_item_id,
  plan.compatibility_artifact_id,
  plan.legacy_topic_id,
  'legacy_backfill',
  plan.legacy_snapshot_json,
  plan.canonical_created_at,
  plan.canonical_updated_at
FROM temp_content_topic_workspace_plan plan;

DROP TABLE temp_content_topic_workspace_plan;

CREATE TRIGGER IF NOT EXISTS trg_content_topic_workspace_links_immutable_identity
BEFORE UPDATE OF
  compat_topic_id, tenant_id, owner_user_id, workspace_item_id,
  compatibility_artifact_id, legacy_topic_id, origin,
  legacy_snapshot_json, created_at
ON content_topic_workspace_links
BEGIN
  SELECT RAISE(ABORT, 'content topic compatibility identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_topic_workspace_links_retirement_once
BEFORE UPDATE OF legacy_schedule_retired_at
ON content_topic_workspace_links
WHEN OLD.legacy_schedule_retired_at IS NOT NULL
  AND NEW.legacy_schedule_retired_at IS NOT OLD.legacy_schedule_retired_at
BEGIN
  SELECT RAISE(ABORT, 'legacy content schedule retirement is immutable');
END;

-- Rollback-window safety: no binary may keep writing the retired root after
-- migration 247. Older code must run only with its exact pre-247 DB snapshot.
CREATE TRIGGER IF NOT EXISTS trg_content_topics_canonical_exit_insert
BEFORE INSERT ON content_topics
BEGIN
  SELECT RAISE(ABORT, 'content_topics is read-only after canonical workspace migration 247');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_topics_canonical_exit_update
BEFORE UPDATE ON content_topics
BEGIN
  SELECT RAISE(ABORT, 'content_topics is read-only after canonical workspace migration 247');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_topics_canonical_exit_delete
BEFORE DELETE ON content_topics
WHEN NOT EXISTS (
  -- The account-erasure transaction creates this short-lived, user-scoped
  -- authorization before deleting any owned tables. Reuse that established
  -- legal-erasure gate so retirement cannot make account deletion impossible.
  SELECT 1
    FROM training_revision_erasure_authorizations authorization
   WHERE authorization.subject_user_id = OLD.user_id
     AND authorization.reason IN ('ACCOUNT_DELETION', 'LEGAL_ERASURE')
     AND datetime(authorization.expires_at) >= datetime('now')
)
BEGIN
  SELECT RAISE(ABORT, 'content_topics is read-only after canonical workspace migration 247');
END;
