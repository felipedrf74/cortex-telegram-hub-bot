-- Migration 094: Content duplicate, novelty, and repurposing controls.
--
-- Adds a tenant-safe artifact novelty ledger and reuse lineage table. This is
-- intentionally deterministic and provider-independent so duplicate/reuse
-- checks can run before prompt construction and without relying on model
-- behavior for tenant separation or editorial policy.

CREATE TABLE IF NOT EXISTS content_novelty_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id TEXT NOT NULL UNIQUE,
    tenant_id INTEGER NOT NULL,
    owner_user_id INTEGER NOT NULL,
    visibility_scope TEXT NOT NULL DEFAULT 'user_private',
    scope_status TEXT NOT NULL DEFAULT 'active',
    artifact_type TEXT NOT NULL,
    title TEXT,
    body TEXT,
    hook TEXT,
    caption TEXT,
    topic TEXT,
    angle TEXT,
    normalized_text TEXT NOT NULL,
    normalized_topic TEXT,
    normalized_hook TEXT,
    normalized_angle TEXT,
    platform_id TEXT,
    format_id TEXT,
    audience TEXT,
    content_pillar TEXT,
    reference_ids_json TEXT NOT NULL DEFAULT '[]',
    source_radar_signal_id TEXT,
    series_id TEXT,
    reuse_intent TEXT NOT NULL DEFAULT 'none',
    original_content_id TEXT,
    transformation_type TEXT,
    novelty_score REAL NOT NULL DEFAULT 1.0,
    duplication_risk_score REAL NOT NULL DEFAULT 0.0,
    reason_codes_json TEXT NOT NULL DEFAULT '[]',
    review_warnings_json TEXT NOT NULL DEFAULT '[]',
    matched_candidate_ids_json TEXT NOT NULL DEFAULT '[]',
    lifecycle_state TEXT NOT NULL DEFAULT 'active',
    created_by INTEGER NOT NULL,
    updated_by INTEGER NOT NULL,
    audit_metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_content_novelty_candidates_scope
    ON content_novelty_candidates(tenant_id, owner_user_id, visibility_scope, scope_status, artifact_type, lifecycle_state);

CREATE INDEX IF NOT EXISTS idx_content_novelty_candidates_topic
    ON content_novelty_candidates(tenant_id, normalized_topic, artifact_type, platform_id, format_id);

CREATE INDEX IF NOT EXISTS idx_content_novelty_candidates_reuse
    ON content_novelty_candidates(tenant_id, original_content_id, series_id, source_radar_signal_id);

CREATE TABLE IF NOT EXISTS content_repurpose_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reuse_id TEXT NOT NULL UNIQUE,
    tenant_id INTEGER NOT NULL,
    owner_user_id INTEGER NOT NULL,
    visibility_scope TEXT NOT NULL DEFAULT 'user_private',
    scope_status TEXT NOT NULL DEFAULT 'active',
    original_content_id TEXT NOT NULL,
    reused_content_id TEXT NOT NULL,
    original_artifact_type TEXT NOT NULL,
    reused_artifact_type TEXT NOT NULL,
    transformation_type TEXT NOT NULL,
    from_platform_id TEXT,
    to_platform_id TEXT,
    references_preserved_json TEXT NOT NULL DEFAULT '[]',
    references_changed_json TEXT NOT NULL DEFAULT '[]',
    novelty_score REAL NOT NULL DEFAULT 0.5,
    reason_codes_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'created',
    created_by INTEGER NOT NULL,
    updated_by INTEGER NOT NULL,
    audit_metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, owner_user_id, original_content_id, reused_content_id, transformation_type)
);

CREATE INDEX IF NOT EXISTS idx_content_repurpose_history_scope
    ON content_repurpose_history(tenant_id, owner_user_id, visibility_scope, scope_status, status);

CREATE INDEX IF NOT EXISTS idx_content_repurpose_history_original
    ON content_repurpose_history(tenant_id, original_content_id, transformation_type);
