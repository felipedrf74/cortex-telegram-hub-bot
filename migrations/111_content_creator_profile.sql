-- CONTENT-UI-O1 (2026-05-04): unified per-tenant ContentCreatorProfile.
--
-- Background: prior to this slice the iOS Content Creator Profile editor
-- (pillars, niches, audience, platforms, voice rules, banned topics,
-- trusted/disliked sources, content goals, language preference, voice
-- examples) persisted to tenant-scoped UserDefaults only. There was no
-- backend route, so the data was device-local and could not influence
-- ideation, radar scoring, or script generation across the user's
-- devices. This migration creates the storage table; the route + state
-- helpers + iOS round-trip ship in the same commit.
--
-- Design: ONE row per (tenant_id, owner_user_id). All list-type fields
-- are stored as JSON TEXT (SQLite has no array type and we want to keep
-- the schema simple — the route serializes/deserializes at the
-- boundary). Schema mirrors the iOS `ContentCreatorProfile` Codable
-- struct so the API payload is a 1:1 mapping.
--
-- Tenant scoping: this table participates in the standard content
-- scope columns (tenant_id, owner_user_id, visibility_scope='user_private',
-- scope_status='active') so it can use `contentScopePredicate` and the
-- existing scope helpers in `services/content-tenant-scope.ts`. Cross-
-- tenant reads are impossible by construction.

CREATE TABLE IF NOT EXISTS content_creator_profile (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id               INTEGER NOT NULL,           -- legacy column for content scope helpers
  tenant_id             INTEGER NOT NULL,
  owner_user_id         INTEGER NOT NULL,
  visibility_scope      TEXT NOT NULL DEFAULT 'user_private',
  lifecycle_state       TEXT NOT NULL DEFAULT 'active',
  scope_status          TEXT NOT NULL DEFAULT 'active',
  created_by            INTEGER NOT NULL,
  updated_by            INTEGER NOT NULL,
  audit_metadata_json   TEXT NOT NULL DEFAULT '{}',

  -- Profile payload (JSON arrays / strings).
  pillars_json          TEXT NOT NULL DEFAULT '[]',
  niches_json           TEXT NOT NULL DEFAULT '[]',
  audience              TEXT NOT NULL DEFAULT '',
  platforms_json        TEXT NOT NULL DEFAULT '[]',
  voice_rules_json      TEXT NOT NULL DEFAULT '[]',
  preferred_formats_json TEXT NOT NULL DEFAULT '[]',
  disliked_topics_json  TEXT NOT NULL DEFAULT '[]',
  banned_topics_json    TEXT NOT NULL DEFAULT '[]',
  trusted_sources_json  TEXT NOT NULL DEFAULT '[]',
  disliked_sources_json TEXT NOT NULL DEFAULT '[]',
  content_goals_json    TEXT NOT NULL DEFAULT '[]',
  language_preference   TEXT NOT NULL DEFAULT '',
  voice_examples_json   TEXT NOT NULL DEFAULT '[]',

  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(tenant_id, owner_user_id)
);

CREATE INDEX IF NOT EXISTS idx_content_creator_profile_tenant_owner
  ON content_creator_profile(tenant_id, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_content_creator_profile_scope_status
  ON content_creator_profile(tenant_id, owner_user_id, scope_status);
