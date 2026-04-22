-- Migration 079: Tenant-scoped reference channels.
--
-- Closes OI-DATA-002 from the portal UI/UX pass. Before this migration
-- channels lived only in the per-user `channels` table (tangled with
-- the content-creator pipeline, no tenant awareness), so the new User
-- Console → Reference Center → Channels tab could only link out to
-- the legacy admin portal.
--
-- Shape mirrors migration 078's tenant_books / tenant_content_notes /
-- tenant_links for UX + implementation consistency:
--   - tenant_id FK → tenants(id)
--   - created_by FK → users(id) for authorship gating
--   - tags_json (JSON array of strings)
--   - kind (source type: youtube, rss, podcast, newsletter, generic)
--   - status (active, muted, archived)
--   - url is the canonical pointer; handle is a display slug
--     (e.g. "@JamesClear" for a YouTube channel)
--
-- Strictly additive. No existing table modified. The per-user
-- `channels` table from earlier migrations stays untouched — it is
-- consumed by the content pipeline and remains usable; tenants that
-- want cross-user shared channels now use `tenant_channels`.

CREATE TABLE IF NOT EXISTS tenant_channels (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       INTEGER NOT NULL,
  created_by      INTEGER NOT NULL,
  title           TEXT NOT NULL,
  url             TEXT,
  handle          TEXT,
  description     TEXT,
  kind            TEXT NOT NULL DEFAULT 'generic'
                    CHECK(kind IN ('generic','rss','youtube','podcast','newsletter','twitter','substack')),
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK(status IN ('active','muted','archived')),
  tags_json       TEXT NOT NULL DEFAULT '[]',
  last_fetched_at TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id)  REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- Primary read pattern: list active channels for a tenant, newest first.
CREATE INDEX IF NOT EXISTS idx_tenant_channels_tenant
  ON tenant_channels (tenant_id, status, updated_at DESC);

-- Secondary: filter by kind (e.g. "all YouTube channels this tenant watches").
CREATE INDEX IF NOT EXISTS idx_tenant_channels_kind
  ON tenant_channels (tenant_id, kind);

-- Rollback:
--   DROP TABLE IF EXISTS tenant_channels;
--   DELETE FROM _migrations WHERE filename = '079_tenant_channels.sql';
