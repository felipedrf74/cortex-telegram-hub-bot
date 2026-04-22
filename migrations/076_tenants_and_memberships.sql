-- Migration 076: Tenants, tenant memberships, and platform admins.
--
-- This migration introduces the multi-tenant foundation that the
-- portal redesign (feature/nexus-hub-owner-workspace-separation) is
-- built on. Three tables are added:
--
--   • tenants          — the SaaS tenant unit (an "account" / "workspace")
--   • tenant_members   — who belongs to a tenant, with a tenant-local role
--   • platform_admins  — users with cross-tenant platform roles (Felipe + future support)
--
-- Why this exists now (audit 2026-04-22):
--
--   Nexus Hub today is "single-owner with many users" — comment in
--   migration 059 literally says "All tables use user_id for
--   multi-tenant isolation." There is no tenant id anywhere. The
--   redesign splits the portal into:
--
--     /owner/*      — platform-owner control plane (cross-tenant)
--     /workspace/*  — tenant-scoped user console
--
--   Both surfaces need a proper tenant model to do server-side
--   permission checks instead of hoping the front-end hides things.
--
-- BACKWARD-SAFETY RULE: this migration is ADDITIVE ONLY.
--   - No existing table is modified.
--   - No FK added to users/subscriptions/audit_trail/etc.
--   - All inserts use INSERT OR IGNORE so re-running is harmless.
--   - Every pre-existing user is backfilled as their own solo tenant
--     (tenant.id == users.id, slug == 'user-<id>') with role
--     'tenant_admin'. So: day-one behavior is unchanged. Every iOS
--     query that filters by users.id still returns exactly the same
--     rows, because the solo tenant's scope is {that one user}.
--   - The resolved owner (env OWNER_TELEGRAM_ID or first users row
--     with tier='owner') is ALSO seeded into platform_admins with
--     role='platform_owner'. If no owner can be resolved at migration
--     time, the seed is skipped silently and runtime code falls back
--     to `isOwnerUserRef`.
--
-- See docs/portal/nexus-hub-portal-owner-workspace-redesign.md for
-- the target architecture, rollback instructions, and phased plan.

CREATE TABLE IF NOT EXISTS tenants (
  id            INTEGER PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  -- Lifecycle: active (normal use) | suspended (ops blocked but data retained)
  -- | archived (read-only, awaiting deletion) | trial (time-bounded free access).
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK(status IN ('active','suspended','archived','trial')),
  -- Plan mirrors users.tier for solo tenants, but is the authoritative
  -- per-tenant axis going forward (Phase 2 will migrate entitlement
  -- resolution to read from here instead of users.tier).
  plan          TEXT NOT NULL DEFAULT 'free'
                  CHECK(plan IN ('free','pro','max','owner','beta')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_by    INTEGER,                         -- users.id; nullable for seed rows
  metadata_json TEXT NOT NULL DEFAULT '{}',      -- JSON extensibility (custom domain, plan add-ons, etc.)
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);
CREATE INDEX IF NOT EXISTS idx_tenants_plan   ON tenants(plan);

-- Membership: who can access which tenant, and with what role.
--
-- tenant_admin  — can manage tenant settings, members, roles, security
-- tenant_member — normal workspace user; manages own books/content/links
-- tenant_viewer — read-only within the tenant (future; for auditors)
--
-- A user can belong to multiple tenants. The (tenant_id, user_id) PK
-- prevents duplicate memberships. The secondary index on user_id
-- makes "list tenants for this user" fast (the tenant switcher path).
CREATE TABLE IF NOT EXISTS tenant_members (
  tenant_id  INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  role       TEXT NOT NULL DEFAULT 'tenant_member'
               CHECK(role IN ('tenant_admin','tenant_member','tenant_viewer')),
  joined_at  TEXT NOT NULL DEFAULT (datetime('now')),
  invited_by INTEGER,                             -- users.id of the inviter; null for seed rows
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)   REFERENCES users(id)  ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tenant_members_user ON tenant_members(user_id);

-- Platform-level roles. Separate from tenant_members because these
-- are CROSS-tenant: holding `platform_admin` lets you enter the
-- /owner/* control plane regardless of tenant membership.
--
-- platform_owner    — superuser (Felipe). Exactly one seeded row.
-- platform_admin    — trusted admin; most /owner/* operations.
-- platform_readonly — support role; GET-only on /owner/*.
CREATE TABLE IF NOT EXISTS platform_admins (
  user_id    INTEGER PRIMARY KEY,
  role       TEXT NOT NULL DEFAULT 'platform_admin'
               CHECK(role IN ('platform_owner','platform_admin','platform_readonly')),
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  granted_by INTEGER,                             -- users.id; null for seed rows
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ── Backfill ───────────────────────────────────────────────────────
--
-- Every existing user becomes their own solo tenant with themselves
-- as tenant_admin. This is the "each user is their own tenant"
-- semantic we've been using implicitly via user_id FKs. After this
-- backfill, every iOS query that reads `WHERE user_id = ?` still
-- returns exactly the same rows — the new tenant scope just wraps
-- that user's data under a tenant id equal to their user id.
--
-- slug = 'user-<id>' is unique, URL-safe, and deterministic. The
-- display_name prefers email, falls back to username, then a
-- placeholder. plan mirrors users.tier so entitlement resolution
-- transitions cleanly when Phase 2 switches the source of truth.

INSERT OR IGNORE INTO tenants (id, slug, display_name, plan, created_at, created_by)
SELECT
  u.id,
  'user-' || u.id,
  COALESCE(NULLIF(u.email, ''), NULLIF(u.username, ''), 'Tenant ' || u.id),
  CASE
    WHEN u.tier = 'owner' THEN 'owner'
    WHEN u.tier IN ('pro','max','beta','free') THEN u.tier
    ELSE 'free'
  END,
  COALESCE(u.created_at, datetime('now')),
  u.id
FROM users u;

INSERT OR IGNORE INTO tenant_members (tenant_id, user_id, role, joined_at)
SELECT
  u.id,
  u.id,
  'tenant_admin',
  COALESCE(u.created_at, datetime('now'))
FROM users u;

-- Platform-owner seed: the first user with tier='owner' (deterministic
-- tiebreaker on id) becomes platform_owner. If there is no such user
-- yet (fresh install before the first owner logs in), the seed is a
-- no-op and runtime code continues to rely on `isOwnerUserRef` for
-- owner checks until the first owner row materializes.
INSERT OR IGNORE INTO platform_admins (user_id, role, granted_at)
SELECT id, 'platform_owner', COALESCE(created_at, datetime('now'))
FROM users
WHERE tier = 'owner'
ORDER BY id ASC
LIMIT 1;
