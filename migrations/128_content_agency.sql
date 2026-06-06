CREATE TABLE IF NOT EXISTS content_agency_briefs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agency_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  visibility_scope TEXT NOT NULL DEFAULT 'user_private',
  platform TEXT,
  format TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  source_trace_json TEXT NOT NULL DEFAULT '[]',
  quality_score INTEGER,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  blockers_json TEXT NOT NULL DEFAULT '[]',
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_content_agency_briefs_scope
  ON content_agency_briefs(tenant_id, user_id, agency_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_content_agency_briefs_scope
  ON content_agency_briefs(tenant_id, user_id, agency_id);

CREATE TABLE IF NOT EXISTS content_competitor_studies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agency_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  visibility_scope TEXT NOT NULL DEFAULT 'user_private',
  platform TEXT,
  format TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  source_trace_json TEXT NOT NULL DEFAULT '[]',
  quality_score INTEGER,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  blockers_json TEXT NOT NULL DEFAULT '[]',
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_content_competitor_studies_scope
  ON content_competitor_studies(tenant_id, user_id, agency_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_content_competitor_studies_scope
  ON content_competitor_studies(tenant_id, user_id, agency_id);

CREATE TABLE IF NOT EXISTS content_transcript_studies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agency_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  visibility_scope TEXT NOT NULL DEFAULT 'user_private',
  platform TEXT,
  format TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  source_trace_json TEXT NOT NULL DEFAULT '[]',
  quality_score INTEGER,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  blockers_json TEXT NOT NULL DEFAULT '[]',
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_content_transcript_studies_scope
  ON content_transcript_studies(tenant_id, user_id, agency_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_content_transcript_studies_scope
  ON content_transcript_studies(tenant_id, user_id, agency_id);

CREATE TABLE IF NOT EXISTS content_agency_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agency_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  visibility_scope TEXT NOT NULL DEFAULT 'user_private',
  platform TEXT,
  format TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  source_trace_json TEXT NOT NULL DEFAULT '[]',
  quality_score INTEGER,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  blockers_json TEXT NOT NULL DEFAULT '[]',
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_content_agency_packages_scope
  ON content_agency_packages(tenant_id, user_id, agency_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_content_agency_packages_scope
  ON content_agency_packages(tenant_id, user_id, agency_id);

CREATE TABLE IF NOT EXISTS content_compliance_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agency_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  visibility_scope TEXT NOT NULL DEFAULT 'user_private',
  platform TEXT,
  format TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  source_trace_json TEXT NOT NULL DEFAULT '[]',
  quality_score INTEGER,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  blockers_json TEXT NOT NULL DEFAULT '[]',
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_content_compliance_reviews_scope
  ON content_compliance_reviews(tenant_id, user_id, agency_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_content_compliance_reviews_scope
  ON content_compliance_reviews(tenant_id, user_id, agency_id);

CREATE TABLE IF NOT EXISTS content_experiment_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agency_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  visibility_scope TEXT NOT NULL DEFAULT 'user_private',
  platform TEXT,
  format TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  source_trace_json TEXT NOT NULL DEFAULT '[]',
  quality_score INTEGER,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  blockers_json TEXT NOT NULL DEFAULT '[]',
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_content_experiment_runs_scope
  ON content_experiment_runs(tenant_id, user_id, agency_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_content_experiment_runs_scope
  ON content_experiment_runs(tenant_id, user_id, agency_id);

CREATE TABLE IF NOT EXISTS content_agency_quality_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agency_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  visibility_scope TEXT NOT NULL DEFAULT 'user_private',
  platform TEXT,
  format TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  source_trace_json TEXT NOT NULL DEFAULT '[]',
  quality_score INTEGER,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  blockers_json TEXT NOT NULL DEFAULT '[]',
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_content_agency_quality_reviews_scope
  ON content_agency_quality_reviews(tenant_id, user_id, agency_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_content_agency_quality_reviews_scope
  ON content_agency_quality_reviews(tenant_id, user_id, agency_id);
