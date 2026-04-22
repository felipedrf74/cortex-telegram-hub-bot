# Nexus Hub Portal — Owner Control Plane + Tenant Workspace Redesign

**Status:** Design note + Phase-1 MVP in progress
**Branch:** `feature/nexus-hub-owner-workspace-separation`
**Backup tag:** `backup/pre-owner-workspace-split-20260422-1544` (at `main@4d1774b`)
**Author:** Claude (SaaS restructuring pass, 2026-04-22)

---

## 1. Why this document exists

The product owner wants the portal to become a **proper multi-tenant SaaS control plane + tenant workspace**:
1. A global **Platform Owner Control Plane** for Felipe (and future platform admins) to manage tenants, users, usage, security across the whole install.
2. A per-tenant **Workspace / User Console** where tenant users manage their own books, content, links, profile, preferences — and where tenant admins manage their tenant's members + settings.

Today the portal is a single admin SPA with 60+ `/api/*` endpoints, all of which are "admin actions from whoever has `PORTAL_ADMIN_TOKEN`." There is no tenant model, no membership table, no user-facing workspace UI. This doc captures reality, the target, and the MVP slice that ships on this branch.

---

## 2. Current state (factual audit)

Two parallel audits produced detailed inventories — full findings are preserved in the commit description. Condensed summary:

### 2.1 Portal is single-process / single-port

- `src/portal/server.ts` (≈4,009 LOC) builds **one Express app** on port `:8200`.
- It mounts the iOS API router (`/api/v1/*`) and the admin `/api/*` routes on the **same app**, separating them only by path-prefix in a single portal-token middleware at `server.ts:1931`.
- One misorder in that middleware chain and iOS JWTs could auth portal routes, or portal tokens could auth iOS routes. The wall is thin.

### 2.2 Admin UI is 100% admin

- `src/portal/portal.html` (5,052 LOC) is a vanilla-JS SPA with two nav groups:
  - **Operations**: Dashboard / Users / AI & Providers / Scheduled Jobs / Skills / Content
  - **Configuration**: Settings / Invite Codes / Founders / Waitlist / Audit Trail
- No user-workspace concept. No "my books / my content / my links" UI. Title: *"Nexus Hub Admin"*.
- Auth is **in-memory Bearer token** entered at a prompt — no localStorage, no URL-injection, no sessions.

### 2.3 60+ portal API routes, all under one roof

Categorized from the audit:
- **Status / read-only** (≈25 routes): `/api/snapshot`, `/api/usage/summary`, `/api/users`, `/api/audit-trail`, `/api/model-config`, `/api/provider-health`, etc.
- **Admin mutations requiring `PORTAL_ADMIN_TOKEN`** (≈15 routes): `/api/users/:id/tier`, `/api/plans/:planId`, `/api/founders`, `/api/waitlist/*`, `/api/model-config PUT`, `/api/settings PUT`.
- **Admin mutations with only WRITE scope** (≈12 routes) — **inconsistency**: `/api/users/:id/suspend`, `/api/skills/toggle`, `/api/action/:name`, `/api/channels`. Semantically identical in sensitivity to the ADMIN-scoped ones.

### 2.4 Scoped portal tokens already exist (groundwork)

`src/api/secret-guards.ts` (lines 27–162):
```
PORTAL_READ_TOKEN   → matches read, write, admin
PORTAL_WRITE_TOKEN  → matches write, admin
PORTAL_ADMIN_TOKEN  → matches admin only
PORTAL_TOKEN        → legacy; only usable when scoped vars absent
                      OR PORTAL_ALLOW_LEGACY_FALLBACK=true
```
`requirePortalTokenByMethod` picks the scope from the HTTP verb (GET/HEAD/OPTIONS = read, else write). Per-route `requirePortalAdminToken` can layer on top.

Constant-time comparisons via `crypto.timingSafeEqual`. Strength check rejects tokens <12 chars or blocklisted defaults at boot. This is solid.

### 2.5 No tenant model in the schema

- `users` (migration 051): `id`, `telegram_id`, `email`, `tier` (free|pro|max|**owner**), `status`, `auth_provider`, quotas, timestamps. **No `access_level` despite CLAUDE.md claiming Phase 1 target.**
- `subscriptions` (050), `audit_trail` (033/044), `plan_configs` (075), `founders` (064), `skill_tiers` (045), `invite_codes` (030), `waitlist` (040).
- **Nothing named `tenants`, `organizations`, `workspaces`, `memberships`.** Multi-tenancy is implicit via `user_id` foreign keys everywhere. Comment in migration 059 literally says *"All tables use user_id for multi-tenant isolation"* — i.e. **every user IS their own tenant**.
- `isOwnerUserRef(userId)` checks `tier === 'owner'` OR matches `OWNER_TELEGRAM_ID` env/DB value. That's the only "admin" signal.

### 2.6 Existing pain points (from audit)

| # | Smell | Impact | File |
|---|---|---|---|
| 1 | Admin + user routes share one app/port | Middleware misorder = auth crossover | `portal/server.ts` + `api/router.ts` |
| 2 | No admin RBAC — only token possession | Any token holder = owner | `secret-guards.ts` |
| 3 | Audit actor hardcoded `actorId: 0` | Can't reconstruct which admin did what | `server.ts:2759, 2917, 2977, 3005` |
| 4 | Duplicate `GET /api/skills` handlers | Second registration wins; confusion | `server.ts:2107, 3530` |
| 5 | `/api/notifications` + `/api/reports` return all users' data | No tenant filter — OK today, leaks at GA | `server.ts:2336, 2361` |
| 6 | Scope inconsistency on destructive POSTs | Some WRITE-scoped when ADMIN-justified | multiple |
| 7 | `/api/v1/admin/content-dashboard` back-door inside iOS router | Surprising; uses portal-token | `router.ts:100-101` |
| 8 | Warmer hardcodes owner | New tenants get cold paths | `server.ts:1237-1242` |
| 9 | `OWNER_TELEGRAM_ID` env + DB can disagree | Bootstrap mismatch risk | `user-service.ts:95-114` |
| 10 | `/api/audit-trail` returns all tenants' rows | No redaction | `server.ts:3207` |

---

## 3. Target architecture

### 3.1 Two clearly separated experiences

```
                          nexus-hub backend (port 8200)
                          │
  ┌───────────────────────┼────────────────────────────┐
  │                       │                            │
  ▼                       ▼                            ▼
/owner/*           /workspace/*                  /api/v1/*
CONTROL PLANE      TENANT WORKSPACE              iOS API
(platform_admin)   (tenant context)              (user JWT; unchanged)
  │                       │                            │
  ▼                       ▼                            ▼
platform_admins    tenant_members             users.id
+ PORTAL_ADMIN     + user session             + tenant scope
  token            + tenant context               resolver
```

- `/owner/*` — platform owner / future platform-admins. Cross-tenant. Requires **BOTH** a valid `PORTAL_ADMIN_TOKEN` **AND** a resolved `platform_admin` identity (so the audit trail has a real actor).
- `/workspace/*` — tenant-scoped user console. Requires a valid iOS JWT, an active tenant context (via `X-Tenant-Id` header or session default), and verified membership in that tenant. Tenant admins get elevated sub-sections (members, invites, tenant settings, tenant security) **inside their own tenant only**.
- `/api/v1/*` (iOS app) — **unchanged in this pass.** Keeps working as today; will migrate to tenant-scoped middleware in a follow-up pass once the workspace surface proves out.
- All existing `/api/*` portal routes **continue to work unchanged** during the MVP. New `/owner/*` routes sit alongside them and gradually take over. Legacy is deprecated, not deleted.

### 3.2 Role model

**Global (platform-level)**
| Role | Granted via | Capabilities |
|---|---|---|
| `platform_owner` | Seed row for Felipe; unique | Everything the owner can do today + new `/owner/*` endpoints |
| `platform_admin` | Portal-invite by platform_owner | Read/write most `/owner/*`; cannot grant `platform_owner` or delete tenants |
| `platform_readonly` | Future — optional support role | Read-only `/owner/*` for customer support |

**Tenant-level** (inside `tenant_members.role`)
| Role | Capabilities |
|---|---|
| `tenant_admin` | Manage tenant settings, members, roles, tenant-local security |
| `tenant_member` | Normal workspace user; manage own books/content/links |
| `tenant_viewer` | Read-only within the tenant (future; for auditors) |

**Principle: least privilege by default.** A new registrant becomes `tenant_member` in a solo tenant whose id = their user id. They get `tenant_admin` on *that* tenant because it's theirs. They get `platform_admin` only by explicit seed.

### 3.3 Data model additions (migration 076)

```sql
CREATE TABLE tenants (
  id            INTEGER PRIMARY KEY,
  slug          TEXT UNIQUE NOT NULL,   -- url-safe short id
  display_name  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'   -- active|suspended|archived|trial
                  CHECK(status IN ('active','suspended','archived','trial')),
  plan          TEXT NOT NULL DEFAULT 'free'     -- free|pro|max (mirrors users.tier for solo)
                  CHECK(plan IN ('free','pro','max','owner')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_by    INTEGER,                         -- users.id
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE tenant_members (
  tenant_id  INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  role       TEXT NOT NULL DEFAULT 'tenant_member'
               CHECK(role IN ('tenant_admin','tenant_member','tenant_viewer')),
  joined_at  TEXT NOT NULL DEFAULT (datetime('now')),
  invited_by INTEGER,
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)   REFERENCES users(id)  ON DELETE CASCADE
);
CREATE INDEX idx_tenant_members_user ON tenant_members(user_id);

CREATE TABLE platform_admins (
  user_id    INTEGER PRIMARY KEY,
  role       TEXT NOT NULL DEFAULT 'platform_admin'
               CHECK(role IN ('platform_owner','platform_admin','platform_readonly')),
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  granted_by INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

**Backfill policy (on first boot):**
- For every existing `users.id = N`, insert `tenants(id=N, slug='user-N', display_name=users.email||telegram_id, plan=users.tier)` and `tenant_members(tenant_id=N, user_id=N, role='tenant_admin')`. Every legacy user becomes their own solo tenant owner. Day-one behavior unchanged.
- For the resolved owner (`isOwnerUserRef`), also insert `platform_admins(user_id=OWNER_ID, role='platform_owner')`.
- All backfills are `INSERT OR IGNORE` so re-running is safe.

### 3.4 Route map

**Owner control plane (new):**
```
/owner/tenants                           GET   list + search
/owner/tenants/:tenantId                 GET   detail (status, plan, counts)
/owner/tenants/:tenantId                 PATCH mutate status/plan (audited)
/owner/tenants/:tenantId/members         GET   list members + roles
/owner/tenants/:tenantId/usage           GET   cost/token/message rollup
/owner/usage                             GET   cross-tenant usage summary
/owner/audit                             GET   full audit trail (unfiltered)
/owner/platform-admins                   GET   list
/owner/platform-admins                   POST  grant (platform_owner only)
/owner/platform-admins/:userId           DELETE revoke (platform_owner only)
```

**Tenant workspace (new):**
```
/workspace/me                            GET   current user + current tenant + memberships
/workspace/tenants                       GET   tenants I'm a member of (switcher)
/workspace/books                         GET/POST/PATCH/DELETE  tenant-scoped
/workspace/content                       GET/POST/PATCH/DELETE  tenant-scoped
/workspace/links                         GET/POST/PATCH/DELETE  tenant-scoped
/workspace/profile                       GET/PATCH my profile
/workspace/preferences                   GET/PATCH my preferences
/workspace/members                       GET (tenant_admin only)  list
/workspace/members                       POST (tenant_admin only) invite
/workspace/members/:userId               PATCH/DELETE (tenant_admin only) role/remove
/workspace/settings                      GET/PATCH (tenant_admin only)
/workspace/usage                         GET tenant-scoped usage
/workspace/security                      GET sessions, active devices, audit-me
```

**Legacy `/api/*` — kept alive, deprecated-in-docs.** Final report flags each one's `/owner/*` replacement for a future migration pass.

### 3.5 Guards

Four new middleware:

1. **`resolvePlatformAdmin`** (owner side): verifies `PORTAL_ADMIN_TOKEN` **AND** resolves `req.portalAdmin = { userId, role }` from the `platform_admins` table. Without both, 401. Audit trail now has a real `actorId`.
2. **`requirePlatformOwner`**: the subset of `resolvePlatformAdmin` that gates `platform_owner`-only actions (granting platform-admin, deleting tenants).
3. **`resolveTenantContext`** (workspace side): reads `X-Tenant-Id` (or falls back to `user.default_tenant`), verifies membership, attaches `req.tenantContext = { tenantId, role, memberSince }`. Without membership, 403 `NOT_A_MEMBER`.
4. **`requireTenantAdmin`**: on top of `resolveTenantContext`, requires `role === 'tenant_admin'`.

All guards are server-side enforced. Frontend hiding is NOT relied upon.

### 3.6 Tenant-scoped query helpers

New `src/services/tenant-service.ts`:
```
resolveSoloTenantId(userId)                   // → users.id for solo tenants
listTenantsForUser(userId)                    // → memberships + roles
listMembersOfTenant(tenantId)
assertMembership(tenantId, userId) throws if not a member
assertTenantAdmin(tenantId, userId)  throws if not tenant_admin
isPlatformAdmin(userId)
getPlatformRole(userId)  → 'platform_owner' | 'platform_admin' | null
```

Every workspace-side service call takes `(tenantId, userId)` and scopes SQL by `tenant_id` AND `user_id`. Cross-tenant reads require an explicit `platform_admin` bypass path in `/owner/*` code — never in `/workspace/*`.

---

## 4. What ships on this branch (MVP slice)

| Scope | In branch | Deferred to follow-up |
|---|---|---|
| Migration 076 (tenants + members + platform_admins + backfill) | ✅ | |
| `tenant-service.ts` with solo-tenant resolution + membership checks | ✅ | |
| `platform-admin-guard.ts` (`resolvePlatformAdmin`, `requirePlatformOwner`) | ✅ | |
| `tenant-context-guard.ts` (`resolveTenantContext`, `requireTenantAdmin`) | ✅ | |
| `/owner/*` router with proof-of-concept endpoints (`/tenants`, `/tenants/:id`, `/usage`) | ✅ | |
| `/workspace/*` router with proof-of-concept endpoints (`/me`, `/tenants`, `/books` stub) | ✅ | |
| Mount both in `portal/server.ts` AFTER existing routes so legacy untouched | ✅ | |
| Tests: guard isolation, membership enforcement, solo-tenant backfill, legacy compat | ✅ | |
| Final report at `docs/portal/nexus-hub-owner-workspace-final-report.md` | ✅ | |
| **Legacy `/api/*` route migration to `/owner/*`** | — | Phase 2 |
| **portal.html SPA split** (owner app vs workspace app) | — | Phase 3 |
| **`/workspace/books` + content + links real backing implementations** | — | Phase 2 |
| **`access_level` column retirement of `tier='owner'`** | — | Phase 2 |
| **iOS `/api/v1/*` route migration to tenant-scoped middleware** | — | Phase 3 |
| **Multi-tenant membership UI** in portal.html | — | Phase 3 |

The MVP is a **foundation** — the schema, guards, and two clearly-separated API surfaces — that the follow-up can build on without fear of breaking prod.

---

## 5. Backward-safety checklist

- [x] All existing `/api/*` routes remain reachable, unmodified, same auth.
- [x] `/api/v1/*` iOS routes unmodified.
- [x] `portal.html` unmodified.
- [x] New routes mount AFTER legacy, under distinct path prefixes.
- [x] Migration 076 is idempotent (`CREATE TABLE IF NOT EXISTS` + `INSERT OR IGNORE`).
- [x] Backfill preserves every existing user in their own solo tenant so no iOS query changes.
- [x] No existing service signature changes — `tenant-service.ts` is a new module.
- [x] No changes to `auth-middleware.ts` or `secret-guards.ts` (we layer on top, don't edit).
- [x] Rollback: `git reset --hard backup/pre-owner-workspace-split-20260422-1544` + re-apply migrations 001–075 (076 is additive-only).

---

## 6. Rollback steps (if anything goes sideways)

```bash
# 1. Drop the new tables (they're additive; no data depends on them yet)
sqlite3 data/nexus.db "DROP TABLE IF EXISTS tenant_members;
                       DROP TABLE IF EXISTS platform_admins;
                       DROP TABLE IF EXISTS tenants;"

# 2. Remove the migration from _migrations so it re-runs on a future re-deploy
sqlite3 data/nexus.db "DELETE FROM _migrations WHERE filename = '076_tenants_and_memberships.sql';"

# 3. Switch the working tree back
git checkout main
git reset --hard backup/pre-owner-workspace-split-20260422-1544
# (main branch stays at 4d1774b; no force-push needed)

# 4. Delete the feature branch once confident
git branch -D feature/nexus-hub-owner-workspace-separation
git push origin --delete feature/nexus-hub-owner-workspace-separation  # if it was pushed
```

The new code is entirely additive. No existing handler changes. Worst case: roll back migration 076, delete the new files, ship. No data lost.

---

## 7. Next steps after this branch merges

1. **Phase 2 (routes)**: walk the audit inventory and migrate each `/api/*` admin route to `/owner/*` one at a time, keeping the legacy route as a thin redirect + deprecation warning header.
2. **Phase 2 (workspace)**: wire `/workspace/books`, `/content`, `/links` to real backing tables (books is `migrations/072_books.sql`; links + content already exist tenant-scoped — just add the `/workspace/*` façade).
3. **Phase 2 (audit trail)**: replace `actorId: 0` with `req.portalAdmin.userId` at every admin-mutation site.
4. **Phase 3 (UI split)**: extract portal.html into `portal-owner.html` (owner SPA) and `portal-workspace.html` (tenant SPA). Owner SPA keeps current admin tabs; workspace SPA is the new user console.
5. **Phase 3 (iOS)**: introduce `X-Tenant-Id` header in iOS auth flow; default to solo tenant for all existing users; `tenant-route-scope.ts` gains tenant membership verification in addition to user-id validation.
6. **Phase 3 (multi-member)**: allow a user to belong to multiple tenants; workspace `/me` returns the list; tenant switcher in the workspace SPA writes `X-Tenant-Id`.
7. **Phase 3 (entitlements)**: move plan + allowed-skills resolution from `users.tier` to `tenants.plan`; `tenant_members.role` becomes the RBAC axis.

Each step is small, reversible, and keeps legacy working.

---

*This doc is the plan-of-record for the separation. The actual MVP implementation is on the `feature/nexus-hub-owner-workspace-separation` branch; the final report at `docs/portal/nexus-hub-owner-workspace-final-report.md` captures what landed, what's still open, and validation evidence.*
