-- Migration 092: Content lifecycle and editorial workflow.
--
-- Adds canonical editorial states, approval records, workflow events, and
-- Secretary scheduling intent metadata for Content Creation. Existing
-- content_topics/status, content_topic_feedback/sentiment, and
-- content_pipeline/stage flows remain intact.

ALTER TABLE content_domain_objects ADD COLUMN editorial_state TEXT DEFAULT 'idea';
ALTER TABLE content_domain_objects ADD COLUMN approval_state TEXT DEFAULT 'not_required';
ALTER TABLE content_domain_objects ADD COLUMN review_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE content_domain_objects ADD COLUMN review_reason_codes_json TEXT DEFAULT '[]';
ALTER TABLE content_domain_objects ADD COLUMN approved_by INTEGER;
ALTER TABLE content_domain_objects ADD COLUMN approved_at TEXT;
ALTER TABLE content_domain_objects ADD COLUMN rejected_reason TEXT;
ALTER TABLE content_domain_objects ADD COLUMN archived_at TEXT;
ALTER TABLE content_domain_objects ADD COLUMN scheduled_for TEXT;
ALTER TABLE content_domain_objects ADD COLUMN secretary_intent_id TEXT;
ALTER TABLE content_domain_objects ADD COLUMN secretary_agenda_item_id TEXT;
ALTER TABLE content_domain_objects ADD COLUMN workflow_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE content_topics ADD COLUMN editorial_state TEXT DEFAULT 'idea';
ALTER TABLE content_topics ADD COLUMN approval_state TEXT DEFAULT 'not_required';
ALTER TABLE content_topics ADD COLUMN review_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE content_topics ADD COLUMN review_reason_codes_json TEXT DEFAULT '[]';
ALTER TABLE content_topics ADD COLUMN approved_by INTEGER;
ALTER TABLE content_topics ADD COLUMN approved_at TEXT;
ALTER TABLE content_topics ADD COLUMN secretary_intent_id TEXT;

ALTER TABLE content_topic_feedback ADD COLUMN radar_lifecycle_state TEXT DEFAULT 'detected';
ALTER TABLE content_topic_feedback ADD COLUMN converted_to_object_id INTEGER;
ALTER TABLE content_topic_feedback ADD COLUMN converted_to_object_type TEXT;
ALTER TABLE content_topic_feedback ADD COLUMN converted_at TEXT;

ALTER TABLE content_scripts ADD COLUMN editorial_state TEXT DEFAULT 'drafted';
ALTER TABLE content_scripts ADD COLUMN approval_state TEXT DEFAULT 'review_required';
ALTER TABLE content_scripts ADD COLUMN review_required INTEGER NOT NULL DEFAULT 1;
ALTER TABLE content_scripts ADD COLUMN review_reason_codes_json TEXT DEFAULT '[]';
ALTER TABLE content_scripts ADD COLUMN approved_by INTEGER;
ALTER TABLE content_scripts ADD COLUMN approved_at TEXT;
ALTER TABLE content_scripts ADD COLUMN revised_from_script_id INTEGER;

ALTER TABLE content_pipeline ADD COLUMN editorial_state TEXT DEFAULT 'selected';
ALTER TABLE content_pipeline ADD COLUMN approval_state TEXT DEFAULT 'not_required';
ALTER TABLE content_pipeline ADD COLUMN review_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE content_pipeline ADD COLUMN review_reason_codes_json TEXT DEFAULT '[]';
ALTER TABLE content_pipeline ADD COLUMN approved_by INTEGER;
ALTER TABLE content_pipeline ADD COLUMN approved_at TEXT;
ALTER TABLE content_pipeline ADD COLUMN secretary_intent_id TEXT;

CREATE TABLE IF NOT EXISTS content_workflow_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    owner_user_id INTEGER NOT NULL,
    visibility_scope TEXT NOT NULL DEFAULT 'user_private',
    scope_status TEXT NOT NULL DEFAULT 'active',
    object_type TEXT NOT NULL,
    object_id TEXT NOT NULL,
    action TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT,
    approval_state TEXT NOT NULL DEFAULT 'not_required',
    review_required INTEGER NOT NULL DEFAULT 0,
    reason_codes_json TEXT NOT NULL DEFAULT '[]',
    actor_user_id INTEGER NOT NULL,
    secretary_intent_id TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_content_workflow_events_scope
    ON content_workflow_events(tenant_id, owner_user_id, visibility_scope, scope_status, object_type, object_id);
CREATE INDEX IF NOT EXISTS idx_content_workflow_events_action
    ON content_workflow_events(tenant_id, action, created_at);

CREATE TABLE IF NOT EXISTS content_approval_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    owner_user_id INTEGER NOT NULL,
    visibility_scope TEXT NOT NULL DEFAULT 'user_private',
    scope_status TEXT NOT NULL DEFAULT 'active',
    object_type TEXT NOT NULL,
    object_id TEXT NOT NULL,
    approval_type TEXT NOT NULL,
    approval_state TEXT NOT NULL DEFAULT 'required',
    required_reason_codes_json TEXT NOT NULL DEFAULT '[]',
    requested_by INTEGER NOT NULL,
    requested_at TEXT NOT NULL DEFAULT (datetime('now')),
    approved_by INTEGER,
    approved_at TEXT,
    rejected_by INTEGER,
    rejected_at TEXT,
    rejection_reason TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE(tenant_id, owner_user_id, object_type, object_id, approval_type)
);
CREATE INDEX IF NOT EXISTS idx_content_approval_records_scope
    ON content_approval_records(tenant_id, owner_user_id, visibility_scope, scope_status, object_type, object_id);
CREATE INDEX IF NOT EXISTS idx_content_approval_records_state
    ON content_approval_records(tenant_id, approval_state, approval_type);
