-- Migration 093: Content radar opportunity engine.
--
-- Normalizes radar/opportunity signals into a tenant-safe ledger with
-- explicit scoring metadata, provenance, duplicate relationships, and
-- lifecycle state. Existing agent_signals and content_topic_feedback flows
-- remain compatible; this table is the canonical opportunity layer for
-- Content Creation.

CREATE TABLE IF NOT EXISTS content_radar_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id TEXT NOT NULL UNIQUE,
    tenant_id INTEGER NOT NULL,
    owner_user_id INTEGER NOT NULL,
    visibility_scope TEXT NOT NULL DEFAULT 'user_private',
    scope_status TEXT NOT NULL DEFAULT 'active',
    source_type TEXT NOT NULL,
    source_reference_id TEXT,
    source_reference_title TEXT,
    source_skill TEXT,
    source_signal_type TEXT,
    topic TEXT NOT NULL,
    normalized_topic TEXT NOT NULL,
    summary TEXT,
    platform_id TEXT,
    format_id TEXT,
    freshness_score REAL NOT NULL DEFAULT 0.5,
    confidence_score REAL NOT NULL DEFAULT 0.5,
    relevance_score REAL NOT NULL DEFAULT 0.5,
    novelty_score REAL NOT NULL DEFAULT 0.5,
    audience_fit_score REAL NOT NULL DEFAULT 0.5,
    brand_fit_score REAL NOT NULL DEFAULT 0.5,
    platform_fit_score REAL NOT NULL DEFAULT 0.5,
    source_quality_score REAL NOT NULL DEFAULT 0.5,
    cross_skill_relevance_score REAL NOT NULL DEFAULT 0.0,
    production_feasibility_score REAL NOT NULL DEFAULT 0.5,
    duplication_risk_score REAL NOT NULL DEFAULT 0.0,
    strategic_value_score REAL NOT NULL DEFAULT 0.5,
    total_score REAL NOT NULL DEFAULT 0.5,
    evidence_json TEXT NOT NULL DEFAULT '[]',
    provenance_json TEXT NOT NULL DEFAULT '{}',
    duplicate_signal_ids_json TEXT NOT NULL DEFAULT '[]',
    related_signal_ids_json TEXT NOT NULL DEFAULT '[]',
    reason_codes_json TEXT NOT NULL DEFAULT '[]',
    lifecycle_state TEXT NOT NULL DEFAULT 'detected',
    review_required INTEGER NOT NULL DEFAULT 0,
    converted_to_object_id INTEGER,
    converted_to_object_type TEXT,
    converted_at TEXT,
    dismissed_at TEXT,
    expired_at TEXT,
    created_by INTEGER NOT NULL,
    updated_by INTEGER NOT NULL,
    audit_metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_content_radar_signals_scope
    ON content_radar_signals(tenant_id, owner_user_id, visibility_scope, scope_status, lifecycle_state, total_score DESC);

CREATE INDEX IF NOT EXISTS idx_content_radar_signals_topic
    ON content_radar_signals(tenant_id, normalized_topic, lifecycle_state);

CREATE INDEX IF NOT EXISTS idx_content_radar_signals_source
    ON content_radar_signals(tenant_id, source_type, source_reference_id, source_skill, source_signal_type);
