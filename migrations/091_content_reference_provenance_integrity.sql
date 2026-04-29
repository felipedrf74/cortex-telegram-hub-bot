-- Migration 091: Content reference, source, and provenance integrity.
--
-- Adds a normalized reference registry and output provenance ledger so
-- Content Creation can trace ideas/scripts back to authorized references,
-- flag unsupported claims, and avoid silently using broken/stale sources.

ALTER TABLE book_library ADD COLUMN broken_status TEXT DEFAULT 'ok';
ALTER TABLE book_library ADD COLUMN stale_status TEXT DEFAULT 'fresh';
ALTER TABLE book_library ADD COLUMN last_used_at TEXT;
ALTER TABLE book_library ADD COLUMN source_summary TEXT;
ALTER TABLE book_library ADD COLUMN source_snippets_json TEXT DEFAULT '[]';

ALTER TABLE content_reference_links ADD COLUMN broken_status TEXT DEFAULT 'unknown';
ALTER TABLE content_reference_links ADD COLUMN stale_status TEXT DEFAULT 'unknown';
ALTER TABLE content_reference_links ADD COLUMN last_used_at TEXT;
ALTER TABLE content_reference_links ADD COLUMN source_summary TEXT;
ALTER TABLE content_reference_links ADD COLUMN source_snippets_json TEXT DEFAULT '[]';

ALTER TABLE content_ref_channels ADD COLUMN broken_status TEXT DEFAULT 'ok';
ALTER TABLE content_ref_channels ADD COLUMN stale_status TEXT DEFAULT 'fresh';
ALTER TABLE content_ref_channels ADD COLUMN extraction_status TEXT DEFAULT 'ready';
ALTER TABLE content_ref_channels ADD COLUMN last_used_at TEXT;
ALTER TABLE content_ref_channels ADD COLUMN source_summary TEXT;
ALTER TABLE content_ref_channels ADD COLUMN source_snippets_json TEXT DEFAULT '[]';

CREATE TABLE IF NOT EXISTS content_reference_registry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    owner_user_id INTEGER NOT NULL,
    visibility_scope TEXT NOT NULL DEFAULT 'user_private',
    scope_status TEXT NOT NULL DEFAULT 'active',
    reference_type TEXT NOT NULL,
    source_table TEXT,
    source_pk TEXT,
    source_identifier TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT,
    author_source TEXT,
    extraction_status TEXT NOT NULL DEFAULT 'pending',
    freshness_score REAL NOT NULL DEFAULT 0.7,
    trust_level TEXT NOT NULL DEFAULT 'unverified',
    quality_score REAL NOT NULL DEFAULT 0.5,
    confidence_score REAL NOT NULL DEFAULT 0.5,
    topic_tags_json TEXT NOT NULL DEFAULT '[]',
    related_output_ids_json TEXT NOT NULL DEFAULT '[]',
    last_used_at TEXT,
    broken_status TEXT NOT NULL DEFAULT 'unknown',
    stale_status TEXT NOT NULL DEFAULT 'unknown',
    source_summary TEXT,
    source_snippets_json TEXT NOT NULL DEFAULT '[]',
    source_metadata_json TEXT NOT NULL DEFAULT '{}',
    created_by INTEGER NOT NULL,
    updated_by INTEGER NOT NULL,
    audit_metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, owner_user_id, reference_type, source_identifier)
);
CREATE INDEX IF NOT EXISTS idx_content_reference_registry_scope
    ON content_reference_registry(tenant_id, owner_user_id, visibility_scope, scope_status, reference_type);
CREATE INDEX IF NOT EXISTS idx_content_reference_registry_quality
    ON content_reference_registry(tenant_id, reference_type, extraction_status, broken_status, stale_status, trust_level);

CREATE TABLE IF NOT EXISTS content_output_provenance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    owner_user_id INTEGER NOT NULL,
    visibility_scope TEXT NOT NULL DEFAULT 'user_private',
    scope_status TEXT NOT NULL DEFAULT 'active',
    output_object_type TEXT NOT NULL,
    output_id TEXT NOT NULL,
    grounding_status TEXT NOT NULL DEFAULT 'ungrounded',
    references_used_json TEXT NOT NULL DEFAULT '[]',
    claims_json TEXT NOT NULL DEFAULT '[]',
    unsupported_claims_json TEXT NOT NULL DEFAULT '[]',
    source_summaries_json TEXT NOT NULL DEFAULT '[]',
    generated_from_radar_signal_id TEXT,
    reused_from_content_id TEXT,
    provenance_status TEXT NOT NULL DEFAULT 'active',
    review_required INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER NOT NULL,
    updated_by INTEGER NOT NULL,
    audit_metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, owner_user_id, output_object_type, output_id)
);
CREATE INDEX IF NOT EXISTS idx_content_output_provenance_scope
    ON content_output_provenance(tenant_id, owner_user_id, visibility_scope, scope_status, output_object_type);
CREATE INDEX IF NOT EXISTS idx_content_output_provenance_grounding
    ON content_output_provenance(tenant_id, grounding_status, review_required);
