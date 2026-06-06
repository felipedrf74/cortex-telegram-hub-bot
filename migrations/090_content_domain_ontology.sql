-- Migration 090: Content Creation domain ontology foundation.
--
-- Adds typed metadata hooks for content objects, platform formats, references,
-- strategy entities, source-output linkage, and reuse relationships. This is
-- intentionally additive: existing Content flows keep using their current
-- tables while newer planning/generation/review flows can attach richer
-- ontology metadata.

ALTER TABLE content_topics ADD COLUMN content_object_type TEXT DEFAULT 'topic';
ALTER TABLE content_topics ADD COLUMN platform_id TEXT;
ALTER TABLE content_topics ADD COLUMN format_id TEXT;
ALTER TABLE content_topics ADD COLUMN pillar_id INTEGER;
ALTER TABLE content_topics ADD COLUMN audience_segment_id INTEGER;
ALTER TABLE content_topics ADD COLUMN campaign_id INTEGER;
ALTER TABLE content_topics ADD COLUMN series_id INTEGER;
ALTER TABLE content_topics ADD COLUMN source_ids_json TEXT DEFAULT '[]';
ALTER TABLE content_topics ADD COLUMN ontology_metadata_json TEXT DEFAULT '{}';
ALTER TABLE content_topics ADD COLUMN ontology_schema_version TEXT DEFAULT 'content-ontology-v1';

ALTER TABLE content_scripts ADD COLUMN content_object_type TEXT DEFAULT 'script';
ALTER TABLE content_scripts ADD COLUMN platform_id TEXT;
ALTER TABLE content_scripts ADD COLUMN format_id TEXT;
ALTER TABLE content_scripts ADD COLUMN pillar_id INTEGER;
ALTER TABLE content_scripts ADD COLUMN audience_segment_id INTEGER;
ALTER TABLE content_scripts ADD COLUMN campaign_id INTEGER;
ALTER TABLE content_scripts ADD COLUMN series_id INTEGER;
ALTER TABLE content_scripts ADD COLUMN source_attribution_json TEXT DEFAULT '[]';
ALTER TABLE content_scripts ADD COLUMN claims_json TEXT DEFAULT '[]';
ALTER TABLE content_scripts ADD COLUMN evidence_json TEXT DEFAULT '[]';
ALTER TABLE content_scripts ADD COLUMN ontology_metadata_json TEXT DEFAULT '{}';
ALTER TABLE content_scripts ADD COLUMN ontology_schema_version TEXT DEFAULT 'content-ontology-v1';

ALTER TABLE content_pipeline ADD COLUMN content_object_type TEXT DEFAULT 'content_calendar_item';
ALTER TABLE content_pipeline ADD COLUMN platform_id TEXT;
ALTER TABLE content_pipeline ADD COLUMN format_id TEXT;
ALTER TABLE content_pipeline ADD COLUMN pillar_id INTEGER;
ALTER TABLE content_pipeline ADD COLUMN audience_segment_id INTEGER;
ALTER TABLE content_pipeline ADD COLUMN campaign_id INTEGER;
ALTER TABLE content_pipeline ADD COLUMN series_id INTEGER;
ALTER TABLE content_pipeline ADD COLUMN source_ids_json TEXT DEFAULT '[]';
ALTER TABLE content_pipeline ADD COLUMN ontology_metadata_json TEXT DEFAULT '{}';
ALTER TABLE content_pipeline ADD COLUMN ontology_schema_version TEXT DEFAULT 'content-ontology-v1';

ALTER TABLE saved_ideas ADD COLUMN content_object_type TEXT DEFAULT 'idea';
ALTER TABLE saved_ideas ADD COLUMN platform_id TEXT;
ALTER TABLE saved_ideas ADD COLUMN format_id TEXT;
ALTER TABLE saved_ideas ADD COLUMN pillar_id INTEGER;
ALTER TABLE saved_ideas ADD COLUMN audience_segment_id INTEGER;
ALTER TABLE saved_ideas ADD COLUMN campaign_id INTEGER;
ALTER TABLE saved_ideas ADD COLUMN series_id INTEGER;
ALTER TABLE saved_ideas ADD COLUMN source_ids_json TEXT DEFAULT '[]';
ALTER TABLE saved_ideas ADD COLUMN ontology_metadata_json TEXT DEFAULT '{}';
ALTER TABLE saved_ideas ADD COLUMN ontology_schema_version TEXT DEFAULT 'content-ontology-v1';

ALTER TABLE content_topic_feedback ADD COLUMN content_object_type TEXT DEFAULT 'radar_signal';
ALTER TABLE content_topic_feedback ADD COLUMN platform_id TEXT;
ALTER TABLE content_topic_feedback ADD COLUMN format_id TEXT;
ALTER TABLE content_topic_feedback ADD COLUMN pillar_id INTEGER;
ALTER TABLE content_topic_feedback ADD COLUMN audience_segment_id INTEGER;
ALTER TABLE content_topic_feedback ADD COLUMN campaign_id INTEGER;
ALTER TABLE content_topic_feedback ADD COLUMN series_id INTEGER;
ALTER TABLE content_topic_feedback ADD COLUMN source_ids_json TEXT DEFAULT '[]';
ALTER TABLE content_topic_feedback ADD COLUMN ontology_metadata_json TEXT DEFAULT '{}';
ALTER TABLE content_topic_feedback ADD COLUMN ontology_schema_version TEXT DEFAULT 'content-ontology-v1';

ALTER TABLE book_library ADD COLUMN source_type TEXT DEFAULT 'book';
ALTER TABLE book_library ADD COLUMN freshness_score REAL DEFAULT 1.0;
ALTER TABLE book_library ADD COLUMN quality_score REAL DEFAULT 0.7;
ALTER TABLE book_library ADD COLUMN trust_level TEXT DEFAULT 'curated';
ALTER TABLE book_library ADD COLUMN topic_tags_json TEXT DEFAULT '[]';
ALTER TABLE book_library ADD COLUMN source_metadata_json TEXT DEFAULT '{}';
ALTER TABLE book_library ADD COLUMN used_by_outputs_json TEXT DEFAULT '[]';
ALTER TABLE book_library ADD COLUMN ontology_schema_version TEXT DEFAULT 'content-ontology-v1';

ALTER TABLE content_reference_links ADD COLUMN freshness_score REAL DEFAULT 0.7;
ALTER TABLE content_reference_links ADD COLUMN quality_score REAL DEFAULT 0.5;
ALTER TABLE content_reference_links ADD COLUMN trust_level TEXT DEFAULT 'unverified';
ALTER TABLE content_reference_links ADD COLUMN topic_tags_json TEXT DEFAULT '[]';
ALTER TABLE content_reference_links ADD COLUMN used_by_outputs_json TEXT DEFAULT '[]';
ALTER TABLE content_reference_links ADD COLUMN ontology_schema_version TEXT DEFAULT 'content-ontology-v1';

ALTER TABLE content_ref_channels ADD COLUMN source_type TEXT DEFAULT 'channel';
ALTER TABLE content_ref_channels ADD COLUMN freshness_score REAL DEFAULT 0.7;
ALTER TABLE content_ref_channels ADD COLUMN quality_score REAL DEFAULT 0.6;
ALTER TABLE content_ref_channels ADD COLUMN trust_level TEXT DEFAULT 'observed';
ALTER TABLE content_ref_channels ADD COLUMN topic_tags_json TEXT DEFAULT '[]';
ALTER TABLE content_ref_channels ADD COLUMN source_metadata_json TEXT DEFAULT '{}';
ALTER TABLE content_ref_channels ADD COLUMN used_by_outputs_json TEXT DEFAULT '[]';
ALTER TABLE content_ref_channels ADD COLUMN ontology_schema_version TEXT DEFAULT 'content-ontology-v1';

CREATE TABLE IF NOT EXISTS content_pillars (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    owner_user_id INTEGER NOT NULL,
    visibility_scope TEXT NOT NULL DEFAULT 'user_private',
    scope_status TEXT NOT NULL DEFAULT 'active',
    pillar_key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    priority INTEGER NOT NULL DEFAULT 3,
    topic_tags_json TEXT NOT NULL DEFAULT '[]',
    created_by INTEGER NOT NULL,
    updated_by INTEGER NOT NULL,
    audit_metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, owner_user_id, pillar_key)
);
CREATE INDEX IF NOT EXISTS idx_content_pillars_scope
    ON content_pillars(tenant_id, owner_user_id, visibility_scope, scope_status);

CREATE TABLE IF NOT EXISTS content_audience_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    owner_user_id INTEGER NOT NULL,
    visibility_scope TEXT NOT NULL DEFAULT 'user_private',
    scope_status TEXT NOT NULL DEFAULT 'active',
    segment_key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    needs_json TEXT NOT NULL DEFAULT '[]',
    objections_json TEXT NOT NULL DEFAULT '[]',
    desired_outcomes_json TEXT NOT NULL DEFAULT '[]',
    created_by INTEGER NOT NULL,
    updated_by INTEGER NOT NULL,
    audit_metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, owner_user_id, segment_key)
);
CREATE INDEX IF NOT EXISTS idx_content_audience_segments_scope
    ON content_audience_segments(tenant_id, owner_user_id, visibility_scope, scope_status);

CREATE TABLE IF NOT EXISTS content_campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    owner_user_id INTEGER NOT NULL,
    visibility_scope TEXT NOT NULL DEFAULT 'user_private',
    scope_status TEXT NOT NULL DEFAULT 'active',
    campaign_key TEXT NOT NULL,
    name TEXT NOT NULL,
    goal TEXT,
    start_date TEXT,
    end_date TEXT,
    status TEXT NOT NULL DEFAULT 'planned',
    platform_priorities_json TEXT NOT NULL DEFAULT '[]',
    created_by INTEGER NOT NULL,
    updated_by INTEGER NOT NULL,
    audit_metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, owner_user_id, campaign_key)
);
CREATE INDEX IF NOT EXISTS idx_content_campaigns_scope
    ON content_campaigns(tenant_id, owner_user_id, visibility_scope, scope_status, status);

CREATE TABLE IF NOT EXISTS content_series (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    owner_user_id INTEGER NOT NULL,
    visibility_scope TEXT NOT NULL DEFAULT 'user_private',
    scope_status TEXT NOT NULL DEFAULT 'active',
    series_key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    cadence TEXT,
    default_format_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_by INTEGER NOT NULL,
    updated_by INTEGER NOT NULL,
    audit_metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, owner_user_id, series_key)
);
CREATE INDEX IF NOT EXISTS idx_content_series_scope
    ON content_series(tenant_id, owner_user_id, visibility_scope, scope_status, status);

CREATE TABLE IF NOT EXISTS content_domain_objects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    owner_user_id INTEGER NOT NULL,
    visibility_scope TEXT NOT NULL DEFAULT 'user_private',
    scope_status TEXT NOT NULL DEFAULT 'active',
    object_type TEXT NOT NULL,
    lifecycle_state TEXT NOT NULL DEFAULT 'captured',
    title TEXT NOT NULL,
    summary TEXT,
    platform_id TEXT,
    format_id TEXT,
    pillar_id INTEGER,
    audience_segment_id INTEGER,
    campaign_id INTEGER,
    series_id INTEGER,
    source_ids_json TEXT NOT NULL DEFAULT '[]',
    claims_json TEXT NOT NULL DEFAULT '[]',
    evidence_json TEXT NOT NULL DEFAULT '[]',
    production_requirements_json TEXT NOT NULL DEFAULT '[]',
    reuse_of_object_id INTEGER,
    repurpose_parent_id INTEGER,
    ontology_metadata_json TEXT NOT NULL DEFAULT '{}',
    ontology_schema_version TEXT NOT NULL DEFAULT 'content-ontology-v1',
    confidence REAL NOT NULL DEFAULT 0.5,
    freshness_score REAL NOT NULL DEFAULT 1.0,
    created_by INTEGER NOT NULL,
    updated_by INTEGER NOT NULL,
    audit_metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_content_domain_objects_scope
    ON content_domain_objects(tenant_id, owner_user_id, visibility_scope, scope_status, object_type);
CREATE INDEX IF NOT EXISTS idx_content_domain_objects_strategy
    ON content_domain_objects(tenant_id, pillar_id, audience_segment_id, campaign_id, series_id);
CREATE INDEX IF NOT EXISTS idx_content_domain_objects_format
    ON content_domain_objects(tenant_id, platform_id, format_id, lifecycle_state);

CREATE TABLE IF NOT EXISTS content_source_output_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    owner_user_id INTEGER NOT NULL,
    visibility_scope TEXT NOT NULL DEFAULT 'user_private',
    scope_status TEXT NOT NULL DEFAULT 'active',
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    output_object_type TEXT NOT NULL,
    output_id TEXT NOT NULL,
    usage_type TEXT NOT NULL DEFAULT 'inspiration',
    attribution_text TEXT,
    claim_ids_json TEXT NOT NULL DEFAULT '[]',
    evidence_ids_json TEXT NOT NULL DEFAULT '[]',
    confidence REAL NOT NULL DEFAULT 0.5,
    created_by INTEGER NOT NULL,
    audit_metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, owner_user_id, source_type, source_id, output_object_type, output_id, usage_type)
);
CREATE INDEX IF NOT EXISTS idx_content_source_output_links_scope
    ON content_source_output_links(tenant_id, owner_user_id, visibility_scope, scope_status);
CREATE INDEX IF NOT EXISTS idx_content_source_output_links_output
    ON content_source_output_links(tenant_id, output_object_type, output_id);
