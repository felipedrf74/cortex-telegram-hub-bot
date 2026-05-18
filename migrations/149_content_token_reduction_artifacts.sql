-- Content token-reduction artifacts.
--
-- These rows make the cost-reduction pipeline reusable without creating an
-- admin-editable prompt/catalog surface. All rows are tenant/user scoped and
-- store compact, provider-safe summaries rather than raw research dumps.

CREATE TABLE IF NOT EXISTS content_creator_voice_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  creator_id INTEGER NOT NULL,
  voice_card_version TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  tone TEXT NOT NULL,
  pacing TEXT NOT NULL,
  audience TEXT NOT NULL,
  cta_style TEXT NOT NULL,
  phrases_to_use_json TEXT NOT NULL DEFAULT '[]',
  phrases_to_avoid_json TEXT NOT NULL DEFAULT '[]',
  content_pillars_json TEXT NOT NULL DEFAULT '[]',
  format_preferences_json TEXT NOT NULL DEFAULT '[]',
  examples_compressed TEXT NOT NULL DEFAULT '',
  prompt_text TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  stored_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(tenant_id, user_id, voice_card_version)
);

CREATE INDEX IF NOT EXISTS idx_content_voice_cards_scope_latest
  ON content_creator_voice_cards(tenant_id, user_id, stored_at DESC);

CREATE TABLE IF NOT EXISTS content_research_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  research_artifact_id TEXT NOT NULL,
  topic_hash TEXT NOT NULL,
  topic TEXT NOT NULL,
  freshness_class TEXT NOT NULL CHECK (freshness_class IN ('cached', 'fresh', 'deep', 'none')),
  language TEXT NOT NULL,
  format TEXT NOT NULL,
  claims_json TEXT NOT NULL DEFAULT '[]',
  unsafe_or_unverified_claims_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  stored_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(tenant_id, user_id, research_artifact_id)
);

CREATE INDEX IF NOT EXISTS idx_content_research_artifacts_scope_topic
  ON content_research_artifacts(tenant_id, user_id, topic_hash, expires_at);

CREATE TABLE IF NOT EXISTS content_source_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  source_package_id TEXT NOT NULL,
  research_artifact_id TEXT NOT NULL,
  topic_hash TEXT NOT NULL,
  freshness_class TEXT NOT NULL CHECK (freshness_class IN ('cached', 'fresh', 'deep', 'none')),
  language TEXT NOT NULL,
  format TEXT NOT NULL,
  sources_json TEXT NOT NULL DEFAULT '[]',
  source_summaries_json TEXT NOT NULL DEFAULT '[]',
  token_estimate INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  stored_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(tenant_id, user_id, source_package_id),
  FOREIGN KEY (tenant_id, user_id, research_artifact_id)
    REFERENCES content_research_artifacts(tenant_id, user_id, research_artifact_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_content_source_packages_scope_research
  ON content_source_packages(tenant_id, user_id, research_artifact_id, expires_at);

CREATE TABLE IF NOT EXISTS content_idea_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  topic_hash TEXT NOT NULL,
  hook_hash TEXT NOT NULL,
  topic TEXT NOT NULL,
  hook TEXT,
  angle TEXT,
  format TEXT,
  source_package_id TEXT,
  accepted INTEGER NOT NULL DEFAULT 0,
  used_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(tenant_id, user_id, topic_hash, hook_hash)
);

CREATE INDEX IF NOT EXISTS idx_content_idea_memory_recent
  ON content_idea_memory(tenant_id, user_id, used_at DESC);
