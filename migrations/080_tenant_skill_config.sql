-- Migration 080: Per-tenant, per-skill configuration.
--
-- Closes OI-DATA-003 from the portal UI/UX pass. Skill Configuration
-- tabs on the User Console were empty-state link-outs pointing users
-- to iOS for edits like "voice guidelines" or "default platform" —
-- no backing storage for tenant-shared skill preferences existed.
--
-- Shape: one row per (tenant_id, skill_id). Stores the whole config
-- as a JSON blob.
--
-- ## Why one blob per skill, not a key-per-row schema?
--
-- The open-items sketch proposed `(tenant_id, skill_id, key, value_json)`
-- with many rows per (tenant, skill). This pass goes with one row
-- per (tenant, skill) carrying a JSON blob for three reasons:
--
--   1. UX: the Configuration form saves the whole config at once.
--      Atomic single-row update matches the single-form save.
--   2. Per-field schema validation happens at the service layer
--      regardless of storage shape — the storage doesn't need to
--      mirror the schema.
--   3. Simpler upserts; one INSERT ... ON CONFLICT per save.
--
-- If we ever need per-key audit history or delta updates, we can
-- add a `tenant_skill_config_history` append-only log without
-- touching this table.
--
-- ## Authz (enforced at the service + route layers)
--
--   - READ  = any tenant member (config is tenant-shared state)
--   - WRITE = tenant_admin only (mirrors /workspace/settings)

CREATE TABLE IF NOT EXISTS tenant_skill_config (
  tenant_id    INTEGER NOT NULL,
  skill_id     TEXT NOT NULL,        -- 'content' | 'secretary' | 'training' | 'finance' | 'cooking'
  config_json  TEXT NOT NULL DEFAULT '{}',
  updated_by   INTEGER,              -- userId of the tenant_admin who last saved
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, skill_id),
  FOREIGN KEY (tenant_id)  REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by) REFERENCES users(id)
);

-- Primary read pattern: "give me skill X's config for tenant Y".
-- The PRIMARY KEY already indexes (tenant_id, skill_id); no secondary
-- index needed.

-- Rollback:
--   DROP TABLE IF EXISTS tenant_skill_config;
--   DELETE FROM _migrations WHERE filename = '080_tenant_skill_config.sql';
