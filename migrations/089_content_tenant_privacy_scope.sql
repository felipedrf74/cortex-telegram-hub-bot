-- Migration 089: Content Creation tenant/privacy scope foundation.
--
-- Content references, drafts, Voice DNA, radar preferences, scripts, and
-- learning artifacts are sensitive creator/business data.  Older tables used
-- user_id plus implicit user_id=0/system semantics.  This migration keeps
-- those rows readable while making tenant/user ownership, visibility, lifecycle,
-- and ambiguous legacy quarantine explicit.

-- ── Reference and Voice/Brand Memory ───────────────────────────────
ALTER TABLE book_library ADD COLUMN tenant_id INTEGER;
ALTER TABLE book_library ADD COLUMN owner_user_id INTEGER;
ALTER TABLE book_library ADD COLUMN visibility_scope TEXT;
ALTER TABLE book_library ADD COLUMN lifecycle_state TEXT;
ALTER TABLE book_library ADD COLUMN scope_status TEXT;
ALTER TABLE book_library ADD COLUMN created_by INTEGER;
ALTER TABLE book_library ADD COLUMN updated_by INTEGER;
ALTER TABLE book_library ADD COLUMN audit_metadata_json TEXT DEFAULT '{}';
UPDATE book_library
   SET tenant_id = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       owner_user_id = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       visibility_scope = CASE WHEN user_id > 0 THEN 'user_private' ELSE 'platform_internal' END,
       lifecycle_state = COALESCE(extraction_status, 'active'),
       scope_status = CASE WHEN user_id > 0 THEN 'active' ELSE 'quarantined' END,
       created_by = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       updated_by = CASE WHEN user_id > 0 THEN user_id ELSE 0 END
 WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_book_library_tenant_scope
  ON book_library(tenant_id, owner_user_id, visibility_scope, scope_status);

ALTER TABLE content_ref_channels ADD COLUMN tenant_id INTEGER;
ALTER TABLE content_ref_channels ADD COLUMN owner_user_id INTEGER;
ALTER TABLE content_ref_channels ADD COLUMN visibility_scope TEXT;
ALTER TABLE content_ref_channels ADD COLUMN lifecycle_state TEXT;
ALTER TABLE content_ref_channels ADD COLUMN scope_status TEXT;
ALTER TABLE content_ref_channels ADD COLUMN created_by INTEGER;
ALTER TABLE content_ref_channels ADD COLUMN updated_by INTEGER;
ALTER TABLE content_ref_channels ADD COLUMN audit_metadata_json TEXT DEFAULT '{}';
UPDATE content_ref_channels
   SET tenant_id = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       owner_user_id = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       visibility_scope = CASE WHEN user_id > 0 THEN 'user_private' ELSE 'platform_internal' END,
       lifecycle_state = COALESCE(status, 'active'),
       scope_status = CASE WHEN user_id > 0 THEN 'active' ELSE 'quarantined' END,
       created_by = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       updated_by = CASE WHEN user_id > 0 THEN user_id ELSE 0 END
 WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_content_ref_channels_tenant_scope
  ON content_ref_channels(tenant_id, owner_user_id, visibility_scope, scope_status, status);

ALTER TABLE content_patterns ADD COLUMN tenant_id INTEGER;
ALTER TABLE content_patterns ADD COLUMN owner_user_id INTEGER;
ALTER TABLE content_patterns ADD COLUMN visibility_scope TEXT;
ALTER TABLE content_patterns ADD COLUMN lifecycle_state TEXT;
ALTER TABLE content_patterns ADD COLUMN scope_status TEXT;
ALTER TABLE content_patterns ADD COLUMN created_by INTEGER;
ALTER TABLE content_patterns ADD COLUMN updated_by INTEGER;
ALTER TABLE content_patterns ADD COLUMN audit_metadata_json TEXT DEFAULT '{}';
UPDATE content_patterns
   SET tenant_id = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       owner_user_id = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       visibility_scope = CASE WHEN user_id > 0 THEN 'user_private' ELSE 'platform_internal' END,
       lifecycle_state = 'active',
       scope_status = CASE WHEN user_id > 0 THEN 'active' ELSE 'quarantined' END,
       created_by = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       updated_by = CASE WHEN user_id > 0 THEN user_id ELSE 0 END
 WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_content_patterns_tenant_scope
  ON content_patterns(tenant_id, owner_user_id, visibility_scope, scope_status, category);

ALTER TABLE content_knowledge ADD COLUMN tenant_id INTEGER;
ALTER TABLE content_knowledge ADD COLUMN owner_user_id INTEGER;
ALTER TABLE content_knowledge ADD COLUMN visibility_scope TEXT;
ALTER TABLE content_knowledge ADD COLUMN lifecycle_state TEXT;
ALTER TABLE content_knowledge ADD COLUMN scope_status TEXT;
ALTER TABLE content_knowledge ADD COLUMN created_by INTEGER;
ALTER TABLE content_knowledge ADD COLUMN updated_by INTEGER;
ALTER TABLE content_knowledge ADD COLUMN audit_metadata_json TEXT DEFAULT '{}';
UPDATE content_knowledge
   SET tenant_id = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       owner_user_id = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       visibility_scope = CASE WHEN user_id > 0 THEN 'user_private' ELSE 'platform_internal' END,
       lifecycle_state = 'active',
       scope_status = CASE WHEN user_id > 0 THEN 'active' ELSE 'quarantined' END,
       created_by = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       updated_by = CASE WHEN user_id > 0 THEN user_id ELSE 0 END
 WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_content_knowledge_tenant_scope
  ON content_knowledge(tenant_id, owner_user_id, visibility_scope, scope_status, category);

CREATE TABLE IF NOT EXISTS content_reference_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 0,
  tenant_id INTEGER NOT NULL,
  owner_user_id INTEGER NOT NULL,
  visibility_scope TEXT NOT NULL DEFAULT 'user_private',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  scope_status TEXT NOT NULL DEFAULT 'active',
  url TEXT NOT NULL,
  title TEXT,
  source_type TEXT NOT NULL DEFAULT 'link',
  extraction_status TEXT NOT NULL DEFAULT 'pending',
  source_metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER NOT NULL,
  updated_by INTEGER NOT NULL,
  audit_metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, owner_user_id, url)
);
CREATE INDEX IF NOT EXISTS idx_content_reference_links_tenant_scope
  ON content_reference_links(tenant_id, owner_user_id, visibility_scope, scope_status);

-- ── Drafts, Scripts, Performance, Radar, Topics, Pipeline ──────────
ALTER TABLE content_scripts ADD COLUMN tenant_id INTEGER;
ALTER TABLE content_scripts ADD COLUMN owner_user_id INTEGER;
ALTER TABLE content_scripts ADD COLUMN visibility_scope TEXT;
ALTER TABLE content_scripts ADD COLUMN lifecycle_state TEXT;
ALTER TABLE content_scripts ADD COLUMN scope_status TEXT;
ALTER TABLE content_scripts ADD COLUMN created_by INTEGER;
ALTER TABLE content_scripts ADD COLUMN updated_by INTEGER;
ALTER TABLE content_scripts ADD COLUMN audit_metadata_json TEXT DEFAULT '{}';
UPDATE content_scripts
   SET tenant_id = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       owner_user_id = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       visibility_scope = CASE WHEN user_id > 0 THEN 'user_private' ELSE 'platform_internal' END,
       lifecycle_state = 'active',
       scope_status = CASE WHEN user_id > 0 THEN 'active' ELSE 'quarantined' END,
       created_by = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       updated_by = CASE WHEN user_id > 0 THEN user_id ELSE 0 END
 WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_content_scripts_tenant_scope
  ON content_scripts(tenant_id, owner_user_id, visibility_scope, scope_status, created_at);

ALTER TABLE content_performance ADD COLUMN tenant_id INTEGER;
ALTER TABLE content_performance ADD COLUMN owner_user_id INTEGER;
ALTER TABLE content_performance ADD COLUMN visibility_scope TEXT;
ALTER TABLE content_performance ADD COLUMN lifecycle_state TEXT;
ALTER TABLE content_performance ADD COLUMN scope_status TEXT;
ALTER TABLE content_performance ADD COLUMN created_by INTEGER;
ALTER TABLE content_performance ADD COLUMN updated_by INTEGER;
ALTER TABLE content_performance ADD COLUMN audit_metadata_json TEXT DEFAULT '{}';
UPDATE content_performance
   SET tenant_id = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       owner_user_id = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       visibility_scope = CASE WHEN user_id > 0 THEN 'user_private' ELSE 'platform_internal' END,
       lifecycle_state = 'active',
       scope_status = CASE WHEN user_id > 0 THEN 'active' ELSE 'quarantined' END,
       created_by = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       updated_by = CASE WHEN user_id > 0 THEN user_id ELSE 0 END
 WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_content_performance_tenant_scope
  ON content_performance(tenant_id, owner_user_id, visibility_scope, scope_status, logged_at);

ALTER TABLE content_learned_patterns ADD COLUMN tenant_id INTEGER;
ALTER TABLE content_learned_patterns ADD COLUMN owner_user_id INTEGER;
ALTER TABLE content_learned_patterns ADD COLUMN visibility_scope TEXT;
ALTER TABLE content_learned_patterns ADD COLUMN lifecycle_state TEXT;
ALTER TABLE content_learned_patterns ADD COLUMN scope_status TEXT;
ALTER TABLE content_learned_patterns ADD COLUMN created_by INTEGER;
ALTER TABLE content_learned_patterns ADD COLUMN updated_by INTEGER;
ALTER TABLE content_learned_patterns ADD COLUMN audit_metadata_json TEXT DEFAULT '{}';
UPDATE content_learned_patterns
   SET tenant_id = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       owner_user_id = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       visibility_scope = CASE WHEN user_id > 0 THEN 'user_private' ELSE 'platform_internal' END,
       lifecycle_state = 'active',
       scope_status = CASE WHEN user_id > 0 THEN 'active' ELSE 'quarantined' END,
       created_by = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       updated_by = CASE WHEN user_id > 0 THEN user_id ELSE 0 END
 WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_content_learned_patterns_tenant_scope
  ON content_learned_patterns(tenant_id, owner_user_id, visibility_scope, scope_status, category);

ALTER TABLE content_radar_preferences ADD COLUMN tenant_id INTEGER;
ALTER TABLE content_radar_preferences ADD COLUMN owner_user_id INTEGER;
ALTER TABLE content_radar_preferences ADD COLUMN visibility_scope TEXT;
ALTER TABLE content_radar_preferences ADD COLUMN lifecycle_state TEXT;
ALTER TABLE content_radar_preferences ADD COLUMN scope_status TEXT;
ALTER TABLE content_radar_preferences ADD COLUMN created_by INTEGER;
ALTER TABLE content_radar_preferences ADD COLUMN updated_by INTEGER;
ALTER TABLE content_radar_preferences ADD COLUMN audit_metadata_json TEXT DEFAULT '{}';
UPDATE content_radar_preferences
   SET tenant_id = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       owner_user_id = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       visibility_scope = CASE WHEN user_id > 0 THEN 'user_private' ELSE 'platform_internal' END,
       lifecycle_state = 'active',
       scope_status = CASE WHEN user_id > 0 THEN 'active' ELSE 'quarantined' END,
       created_by = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       updated_by = CASE WHEN user_id > 0 THEN user_id ELSE 0 END
 WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_content_radar_preferences_tenant_scope
  ON content_radar_preferences(tenant_id, owner_user_id, visibility_scope, scope_status);

ALTER TABLE content_topics ADD COLUMN tenant_id INTEGER;
ALTER TABLE content_topics ADD COLUMN owner_user_id INTEGER;
ALTER TABLE content_topics ADD COLUMN visibility_scope TEXT;
ALTER TABLE content_topics ADD COLUMN lifecycle_state TEXT;
ALTER TABLE content_topics ADD COLUMN scope_status TEXT;
ALTER TABLE content_topics ADD COLUMN created_by INTEGER;
ALTER TABLE content_topics ADD COLUMN updated_by INTEGER;
ALTER TABLE content_topics ADD COLUMN audit_metadata_json TEXT DEFAULT '{}';
UPDATE content_topics
   SET tenant_id = user_id,
       owner_user_id = user_id,
       visibility_scope = 'user_private',
       lifecycle_state = COALESCE(status, 'planned'),
       scope_status = 'active',
       created_by = user_id,
       updated_by = user_id
 WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_content_topics_tenant_scope
  ON content_topics(tenant_id, owner_user_id, visibility_scope, scope_status, status);

ALTER TABLE content_topic_feedback ADD COLUMN tenant_id INTEGER;
ALTER TABLE content_topic_feedback ADD COLUMN owner_user_id INTEGER;
ALTER TABLE content_topic_feedback ADD COLUMN visibility_scope TEXT;
ALTER TABLE content_topic_feedback ADD COLUMN lifecycle_state TEXT;
ALTER TABLE content_topic_feedback ADD COLUMN scope_status TEXT;
ALTER TABLE content_topic_feedback ADD COLUMN created_by INTEGER;
ALTER TABLE content_topic_feedback ADD COLUMN updated_by INTEGER;
ALTER TABLE content_topic_feedback ADD COLUMN audit_metadata_json TEXT DEFAULT '{}';
UPDATE content_topic_feedback
   SET tenant_id = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       owner_user_id = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       visibility_scope = CASE WHEN user_id > 0 THEN 'user_private' ELSE 'platform_internal' END,
       lifecycle_state = COALESCE(sentiment, 'pending'),
       scope_status = CASE WHEN user_id > 0 THEN 'active' ELSE 'quarantined' END,
       created_by = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       updated_by = CASE WHEN user_id > 0 THEN user_id ELSE 0 END
 WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_content_topic_feedback_tenant_scope
  ON content_topic_feedback(tenant_id, owner_user_id, visibility_scope, scope_status, sentiment);

-- content_pipeline was created before the broad content user-isolation
-- migrations and some fresh environments still lack user_id.  Add it here
-- before deriving tenant scope.
ALTER TABLE content_pipeline ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_content_pipeline_user ON content_pipeline(user_id);
ALTER TABLE content_pipeline ADD COLUMN tenant_id INTEGER;
ALTER TABLE content_pipeline ADD COLUMN owner_user_id INTEGER;
ALTER TABLE content_pipeline ADD COLUMN visibility_scope TEXT;
ALTER TABLE content_pipeline ADD COLUMN lifecycle_state TEXT;
ALTER TABLE content_pipeline ADD COLUMN scope_status TEXT;
ALTER TABLE content_pipeline ADD COLUMN created_by INTEGER;
ALTER TABLE content_pipeline ADD COLUMN updated_by INTEGER;
ALTER TABLE content_pipeline ADD COLUMN audit_metadata_json TEXT DEFAULT '{}';
UPDATE content_pipeline
   SET tenant_id = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       owner_user_id = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       visibility_scope = CASE WHEN user_id > 0 THEN 'user_private' ELSE 'platform_internal' END,
       lifecycle_state = COALESCE(stage, 'active'),
       scope_status = CASE WHEN user_id > 0 THEN 'active' ELSE 'quarantined' END,
       created_by = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       updated_by = CASE WHEN user_id > 0 THEN user_id ELSE 0 END
 WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_content_pipeline_tenant_scope
  ON content_pipeline(tenant_id, owner_user_id, visibility_scope, scope_status, stage);

ALTER TABLE saved_ideas ADD COLUMN tenant_id INTEGER;
ALTER TABLE saved_ideas ADD COLUMN owner_user_id INTEGER;
ALTER TABLE saved_ideas ADD COLUMN visibility_scope TEXT;
ALTER TABLE saved_ideas ADD COLUMN lifecycle_state TEXT;
ALTER TABLE saved_ideas ADD COLUMN scope_status TEXT;
ALTER TABLE saved_ideas ADD COLUMN created_by INTEGER;
ALTER TABLE saved_ideas ADD COLUMN updated_by INTEGER;
ALTER TABLE saved_ideas ADD COLUMN audit_metadata_json TEXT DEFAULT '{}';
UPDATE saved_ideas
   SET tenant_id = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       owner_user_id = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       visibility_scope = CASE WHEN user_id > 0 THEN 'user_private' ELSE 'platform_internal' END,
       lifecycle_state = COALESCE(status, 'saved'),
       scope_status = CASE WHEN user_id > 0 THEN 'active' ELSE 'quarantined' END,
       created_by = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       updated_by = CASE WHEN user_id > 0 THEN user_id ELSE 0 END
 WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_saved_ideas_tenant_scope
  ON saved_ideas(tenant_id, owner_user_id, visibility_scope, scope_status, status);

-- ── Notifications, Research, Retrieval Caches ─────────────────────
ALTER TABLE content_notifications ADD COLUMN tenant_id INTEGER;
ALTER TABLE content_notifications ADD COLUMN owner_user_id INTEGER;
ALTER TABLE content_notifications ADD COLUMN visibility_scope TEXT;
ALTER TABLE content_notifications ADD COLUMN lifecycle_state TEXT;
ALTER TABLE content_notifications ADD COLUMN scope_status TEXT;
ALTER TABLE content_notifications ADD COLUMN created_by INTEGER;
ALTER TABLE content_notifications ADD COLUMN updated_by INTEGER;
ALTER TABLE content_notifications ADD COLUMN audit_metadata_json TEXT DEFAULT '{}';
UPDATE content_notifications
   SET tenant_id = user_id,
       owner_user_id = user_id,
       visibility_scope = 'user_private',
       lifecycle_state = COALESCE(status, 'unread'),
       scope_status = 'active',
       created_by = user_id,
       updated_by = user_id
 WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_content_notifications_tenant_scope
  ON content_notifications(tenant_id, owner_user_id, visibility_scope, scope_status, status);

ALTER TABLE content_research_briefs ADD COLUMN tenant_id INTEGER;
ALTER TABLE content_research_briefs ADD COLUMN owner_user_id INTEGER;
ALTER TABLE content_research_briefs ADD COLUMN visibility_scope TEXT;
ALTER TABLE content_research_briefs ADD COLUMN lifecycle_state TEXT;
ALTER TABLE content_research_briefs ADD COLUMN scope_status TEXT;
ALTER TABLE content_research_briefs ADD COLUMN created_by INTEGER;
ALTER TABLE content_research_briefs ADD COLUMN updated_by INTEGER;
ALTER TABLE content_research_briefs ADD COLUMN audit_metadata_json TEXT DEFAULT '{}';
UPDATE content_research_briefs
   SET tenant_id = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       owner_user_id = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       visibility_scope = CASE WHEN user_id > 0 THEN 'user_private' ELSE 'platform_internal' END,
       lifecycle_state = 'active',
       scope_status = CASE WHEN user_id > 0 THEN 'active' ELSE 'quarantined' END,
       created_by = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       updated_by = CASE WHEN user_id > 0 THEN user_id ELSE 0 END
 WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_content_research_briefs_tenant_scope
  ON content_research_briefs(tenant_id, owner_user_id, visibility_scope, scope_status, created_at);

ALTER TABLE content_search_cache ADD COLUMN tenant_id INTEGER;
ALTER TABLE content_search_cache ADD COLUMN owner_user_id INTEGER;
ALTER TABLE content_search_cache ADD COLUMN visibility_scope TEXT;
ALTER TABLE content_search_cache ADD COLUMN lifecycle_state TEXT;
ALTER TABLE content_search_cache ADD COLUMN scope_status TEXT;
ALTER TABLE content_search_cache ADD COLUMN created_by INTEGER;
ALTER TABLE content_search_cache ADD COLUMN updated_by INTEGER;
ALTER TABLE content_search_cache ADD COLUMN audit_metadata_json TEXT DEFAULT '{}';
UPDATE content_search_cache
   SET tenant_id = 0,
       owner_user_id = 0,
       visibility_scope = 'platform_internal',
       lifecycle_state = 'cached',
       scope_status = 'quarantined',
       created_by = 0,
       updated_by = 0
 WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_content_search_cache_tenant_scope
  ON content_search_cache(tenant_id, owner_user_id, visibility_scope, scope_status, expires_at);

ALTER TABLE content_search_results ADD COLUMN tenant_id INTEGER;
ALTER TABLE content_search_results ADD COLUMN owner_user_id INTEGER;
ALTER TABLE content_search_results ADD COLUMN visibility_scope TEXT;
ALTER TABLE content_search_results ADD COLUMN lifecycle_state TEXT;
ALTER TABLE content_search_results ADD COLUMN scope_status TEXT;
ALTER TABLE content_search_results ADD COLUMN created_by INTEGER;
ALTER TABLE content_search_results ADD COLUMN updated_by INTEGER;
ALTER TABLE content_search_results ADD COLUMN audit_metadata_json TEXT DEFAULT '{}';
UPDATE content_search_results
   SET tenant_id = 0,
       owner_user_id = 0,
       visibility_scope = 'platform_internal',
       lifecycle_state = 'active',
       scope_status = 'quarantined',
       created_by = 0,
       updated_by = 0
 WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_content_search_results_tenant_scope
  ON content_search_results(tenant_id, owner_user_id, visibility_scope, scope_status);

ALTER TABLE content_trending_topics ADD COLUMN tenant_id INTEGER;
ALTER TABLE content_trending_topics ADD COLUMN owner_user_id INTEGER;
ALTER TABLE content_trending_topics ADD COLUMN visibility_scope TEXT;
ALTER TABLE content_trending_topics ADD COLUMN lifecycle_state TEXT;
ALTER TABLE content_trending_topics ADD COLUMN scope_status TEXT;
ALTER TABLE content_trending_topics ADD COLUMN created_by INTEGER;
ALTER TABLE content_trending_topics ADD COLUMN updated_by INTEGER;
ALTER TABLE content_trending_topics ADD COLUMN audit_metadata_json TEXT DEFAULT '{}';
UPDATE content_trending_topics
   SET tenant_id = 0,
       owner_user_id = 0,
       visibility_scope = 'platform_internal',
       lifecycle_state = 'active',
       scope_status = 'quarantined',
       created_by = 0,
       updated_by = 0
 WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_content_trending_topics_tenant_scope
  ON content_trending_topics(tenant_id, owner_user_id, visibility_scope, scope_status, heat_score);

ALTER TABLE video_transcripts ADD COLUMN tenant_id INTEGER;
ALTER TABLE video_transcripts ADD COLUMN owner_user_id INTEGER;
ALTER TABLE video_transcripts ADD COLUMN visibility_scope TEXT;
ALTER TABLE video_transcripts ADD COLUMN lifecycle_state TEXT;
ALTER TABLE video_transcripts ADD COLUMN scope_status TEXT;
ALTER TABLE video_transcripts ADD COLUMN created_by INTEGER;
ALTER TABLE video_transcripts ADD COLUMN updated_by INTEGER;
ALTER TABLE video_transcripts ADD COLUMN audit_metadata_json TEXT DEFAULT '{}';
UPDATE video_transcripts
   SET tenant_id = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       owner_user_id = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       visibility_scope = CASE WHEN user_id > 0 THEN 'user_private' ELSE 'platform_internal' END,
       lifecycle_state = 'active',
       scope_status = CASE WHEN user_id > 0 THEN 'active' ELSE 'quarantined' END,
       created_by = CASE WHEN user_id > 0 THEN user_id ELSE 0 END,
       updated_by = CASE WHEN user_id > 0 THEN user_id ELSE 0 END
 WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_video_transcripts_tenant_scope
  ON video_transcripts(tenant_id, owner_user_id, visibility_scope, scope_status);

ALTER TABLE video_studies ADD COLUMN tenant_id INTEGER;
ALTER TABLE video_studies ADD COLUMN owner_user_id INTEGER;
ALTER TABLE video_studies ADD COLUMN visibility_scope TEXT;
ALTER TABLE video_studies ADD COLUMN lifecycle_state TEXT;
ALTER TABLE video_studies ADD COLUMN scope_status TEXT;
ALTER TABLE video_studies ADD COLUMN created_by INTEGER;
ALTER TABLE video_studies ADD COLUMN updated_by INTEGER;
ALTER TABLE video_studies ADD COLUMN audit_metadata_json TEXT DEFAULT '{}';
UPDATE video_studies
   SET tenant_id = 0,
       owner_user_id = 0,
       visibility_scope = 'platform_internal',
       lifecycle_state = COALESCE(study_type, 'active'),
       scope_status = 'quarantined',
       created_by = 0,
       updated_by = 0
 WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_video_studies_tenant_scope
  ON video_studies(tenant_id, owner_user_id, visibility_scope, scope_status, study_type);
