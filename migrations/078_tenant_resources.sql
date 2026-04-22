-- Migration 078: Tenant-scoped user resources — books, content, links.
--
-- Turns the Phase-1 /workspace/books stub into a real table-backed
-- CRUD, adds /workspace/content + /workspace/links. Closes the
-- "users can manage their own books/content/links" line from the
-- original acceptance criteria.
--
-- ## Design
--
-- Three parallel tables, same base shape:
--   id                INTEGER PK AUTOINCREMENT
--   tenant_id         INTEGER FK → tenants(id) ON DELETE CASCADE
--   created_by        INTEGER FK → users(id)
--   created_at        TEXT DEFAULT datetime('now')
--   updated_at        TEXT DEFAULT datetime('now')
--   (resource-specific columns)
--
-- Every query in the workspace router filters by
-- `tenant_id = req.tenantContext.tenantId` so cross-tenant isolation
-- is enforced at the WHERE clause AND at the membership guard. Two
-- walls between tenants.
--
-- ## Authorship
--
-- `created_by` is captured on every row for attribution. The service
-- enforces: within a tenant, the author OR any tenant_admin can
-- mutate a row; tenant_viewer is read-only. tenant_member can create
-- and mutate their own rows but not others'.
--
-- ## Why not reuse existing tables (content_knowledge, etc.)?
--
-- The audit inventory showed `content_knowledge` is user-id-keyed
-- with no tenant scope, category-constrained, and tangled with the
-- content-creator pipeline. Wrapping it behind /workspace/* would
-- have required a large refactor + risk to the existing content
-- engine. These new tables are workspace-owned, minimal, and
-- retrofit-ready if we later decide to unify.
--
-- Strictly additive — no existing table is modified.

-- ── Books ─────────────────────────────────────────────────────────
-- A tenant member's personal library. Title + author are required;
-- everything else optional. `finished_at` doubles as a status flag
-- (null = in-progress, non-null = finished).

CREATE TABLE IF NOT EXISTS tenant_books (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL,
  created_by   INTEGER NOT NULL,
  title        TEXT NOT NULL,
  author       TEXT,
  notes        TEXT,
  tags_json    TEXT NOT NULL DEFAULT '[]',   -- JSON array of strings
  status       TEXT NOT NULL DEFAULT 'reading'
                 CHECK(status IN ('want_to_read','reading','finished','abandoned')),
  finished_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id)  REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_books_tenant
  ON tenant_books (tenant_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_tenant_books_author
  ON tenant_books (tenant_id, author);

-- ── Content notes ─────────────────────────────────────────────────
-- Generic tenant-scoped "content" entries — ideas, drafts, snippets.
-- A content creator's scratchpad. Intentionally NOT coupled to the
-- content-engine pipeline (content_pipeline, content_knowledge) —
-- this is the workspace-owned surface, the pipeline is a platform
-- concern that Phase 3 can wire through if desired.

CREATE TABLE IF NOT EXISTS tenant_content_notes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL,
  created_by   INTEGER NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',    -- markdown-ish plain text
  kind         TEXT NOT NULL DEFAULT 'note'
                 CHECK(kind IN ('note','idea','draft','published')),
  tags_json    TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id)  REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_content_notes_tenant
  ON tenant_content_notes (tenant_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_tenant_content_notes_kind
  ON tenant_content_notes (tenant_id, kind);

-- ── Links ─────────────────────────────────────────────────────────
-- URL bookmarks — tenant-scoped, author-attributed. url is the
-- only required field; title/description are fetched-on-demand or
-- set manually by the user (this migration doesn't do link preview
-- resolution — that's a future feature).

CREATE TABLE IF NOT EXISTS tenant_links (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL,
  created_by   INTEGER NOT NULL,
  url          TEXT NOT NULL,
  title        TEXT,
  description  TEXT,
  tags_json    TEXT NOT NULL DEFAULT '[]',
  is_favorite  INTEGER NOT NULL DEFAULT 0,   -- 0/1 flag
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id)  REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_links_tenant
  ON tenant_links (tenant_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_tenant_links_favorite
  ON tenant_links (tenant_id, is_favorite) WHERE is_favorite = 1;

-- Rollback:
--   DROP TABLE IF EXISTS tenant_books;
--   DROP TABLE IF EXISTS tenant_content_notes;
--   DROP TABLE IF EXISTS tenant_links;
--   DELETE FROM _migrations WHERE filename = '078_tenant_resources.sql';
