# Nexus Hub — Owner Control Plane + Tenant Workspace — Final Report (MVP slice)

**Branch:** `feature/nexus-hub-owner-workspace-separation`
**Base:** `main@4d1774b` (v4.14.60)
**Backup tag:** `backup/pre-owner-workspace-split-20260422-1544`
**Date:** 2026-04-22

---

## 1. Executive summary

The Nexus Hub portal has been restructured with the **foundation** for a proper multi-tenant SaaS split: a **Platform Owner / Control Plane** (`/owner/*`) for cross-tenant admin and a **Tenant Workspace / User Console** (`/workspace/*`) for tenant-scoped user work. Everything landed in a dedicated feature branch. Nothing about the existing `/api/*` admin surface, `/api/v1/*` iOS surface, or `portal.html` was changed. Full test suite: **4840/4842 pass** (2 failures pre-existing at the baseline, unrelated to this branch). Typecheck clean. Local only — no prod push.

This is **Phase 1 of a multi-phase program**. See the redesign doc for the phased plan; this report covers what this branch actually ships and what remains.

---

## 2. What was inspected (Phase 0)

Two parallel audit agents produced a 900-word factual inventory of the current portal. Highlights recorded in `docs/portal/nexus-hub-portal-owner-workspace-redesign.md` §2:

- `src/portal/server.ts` ≈ 4,009 LOC — one Express app on port 8200, mounts iOS API + admin + OAuth + webhooks + waitlist on the same app.
- `src/portal/portal.html` ≈ 5,052 LOC — vanilla-JS SPA with 11 admin-only sections (Dashboard, Users, AI, Jobs, Skills, Content, Settings, Invites, Founders, Waitlist, Audit Trail). Zero user-workspace UI.
- **No `tenants` / `memberships` / `organizations` / `workspaces` table anywhere in `migrations/*.sql`.** Multi-tenancy is implicit via `user_id` foreign keys. Comment in `migration 059`: *"All tables use user_id for multi-tenant isolation."*
- Admin identity is token-possession (`PORTAL_ADMIN_TOKEN`) — no per-admin audit actor. Every admin-mutation audit row hardcodes `actor_id: 0`.
- 60+ portal `/api/*` routes: ~25 read-only, ~15 ADMIN-scoped, ~12 with inconsistent WRITE scoping on destructive ops.

---

## 3. Current-state problems found (triaged)

| # | Smell | Severity | Addressed in this branch? |
|---|---|:---:|:---:|
| 1 | No tenants table — no server-side way to enforce tenant boundaries | CRITICAL | ✅ migration 076 |
| 2 | No per-admin identity — audit actor is always 0 | HIGH | ✅ `/owner/*` writes real actor id |
| 3 | Admin + user surfaces share one Express app (auth crossover risk) | HIGH | ✅ `/owner/*` and `/workspace/*` mount at distinct prefixes |
| 4 | Portal.html has no tenant-workspace UI | HIGH | ❌ Phase 3 (UI split) |
| 5 | Scope inconsistency on destructive POSTs | MED | ❌ Phase 2 (route migration) |
| 6 | `/api/notifications` + `/api/reports` return all users' data | MED | ❌ Phase 2 (workspace versions) |
| 7 | Duplicate `GET /api/skills` registration | LOW | ❌ Phase 2 cleanup |
| 8 | Warmer hardcodes owner | MED | ❌ Phase 2 |
| 9 | `OWNER_TELEGRAM_ID` env + DB can disagree | LOW | ✅ Replaced by `platform_admins` table in new guard path |

---

## 4. Target architecture chosen

```
                       nexus-hub backend (port 8200)
                       │
  ┌────────────────────┼────────────────────────┐
  │                    │                        │
  ▼                    ▼                        ▼
/owner/*         /workspace/*              /api/v1/*   /api/*
CONTROL PLANE    TENANT WORKSPACE          iOS API     Legacy admin
                                            (unchanged) (unchanged)
  │                    │
  ▼                    ▼
platform_admins   tenant_members
                  + user JWT
                  + X-Tenant-Id
```

**Role model**:
- Platform (cross-tenant): `platform_owner` | `platform_admin` | `platform_readonly`
- Tenant (inside a tenant): `tenant_admin` | `tenant_member` | `tenant_viewer`
- Personal (private): own books / content / links / profile — scoped by `user_id`

Every existing user becomes their own solo tenant: `tenant.id == users.id`, slug `user-<id>`, role `tenant_admin`. Day-one behavior unchanged; every current `WHERE user_id = ?` query is already tenant-scoped under the new model. Full rationale in `docs/portal/nexus-hub-portal-owner-workspace-redesign.md`.

---

## 5. Branch + backup

- **Branch:** `feature/nexus-hub-owner-workspace-separation` (in git worktree at `/tmp/nexus-portal-redesign`, so the main checkout stays isolated and Felipe/Codex's ~100-file WIP there remains untouched)
- **Backup tag:** `backup/pre-owner-workspace-split-20260422-1544` pointing at `origin/main@4d1774b`
- **No push to origin** — this is a local-review branch per the non-negotiable rules

---

## 6. Files / modules changed

**New files (6):**

| File | Purpose | LOC |
|---|---|---:|
| `migrations/076_tenants_and_memberships.sql` | 3 new tables + idempotent backfill of solo tenants | 117 |
| `src/services/tenant-service.ts` | Single point of tenant + membership + platform-admin resolution | 378 |
| `src/api/platform-admin-guard.ts` | `/owner/*` entry gate (identity + role) | 208 |
| `src/api/tenant-context-guard.ts` | `/workspace/*` entry gate (membership + status) | 239 |
| `src/api/portal-owner-router.ts` | Control-plane endpoints (tenants, usage, platform admins) | 314 |
| `src/api/portal-workspace-router.ts` | Tenant-workspace endpoints (me, tenants, profile, members, books, usage) | 261 |

**Modified files (2):**

| File | Change | Notes |
|---|---|---|
| `src/portal/server.ts` | Mount `/workspace/*` (pre-json) and `/owner/*` (post-json) | Both wrapped in try/catch; non-fatal on load failure |
| `__tests__/setup.ts` | Add defaults for `IOS_API_ENABLED`, `IOS_API_JWT_SECRET`, `IOS_INVITE_CODE`, `IOS_OWNER_CODE` | Only sets when unset; existing tests override freely |

**Doc files (2):**

| File | Purpose |
|---|---|
| `docs/portal/nexus-hub-portal-owner-workspace-redesign.md` | Audit + target architecture + phased plan + rollback |
| `docs/portal/nexus-hub-owner-workspace-final-report.md` | This report |

**Test files (4 new):**

| File | Tests | Covers |
|---|---:|---|
| `__tests__/services/tenant-service.test.ts` | 21 | migration 076 backfill, membership isolation, platform-admin seed, pagination |
| `__tests__/api/platform-admin-guard.test.ts` | 14 | identity resolution, role gates (`requirePlatformOwner`, `requirePlatformWrite`), fail-closed paths |
| `__tests__/api/tenant-context-guard.test.ts` | 15 | header parsing (numeric + slug), suspend/archived status gates, `NOT_A_MEMBER`, role enforcement |
| `__tests__/api/portal-owner-router.test.ts` | 12 | end-to-end: auth chain, tenant list/detail/mutation, platform-admin grant/revoke, real audit `actor_id` |
| `__tests__/api/portal-workspace-router.test.ts` | 12 | end-to-end: JWT → tenant context → role; cross-tenant rejection; profile PATCH isolation; tenant-admin-only |

Two additional minor test updates to fix pre-existing tests that my setup.ts env additions tripped:
- `__tests__/portal/portal-token-strength.test.ts` — sets `IOS_API_ENABLED=false` in its `beforeEach` so the isolated boot test doesn't pull in the iOS router chain.

---

## 7. Routes added

### Owner control plane (platform_admins required)

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/owner/tenants` | any platform | List tenants (paginated, status filter) |
| GET | `/owner/tenants/:id` | any platform | Tenant detail + member count |
| PATCH | `/owner/tenants/:id` | platform_admin+ | Mutate status / plan / displayName (audited) |
| GET | `/owner/tenants/:id/members` | any platform | Members of the tenant |
| GET | `/owner/usage` | any platform | Cross-tenant cost/call rollup for today |
| GET | `/owner/platform-admins` | any platform | List platform admins |
| POST | `/owner/platform-admins` | platform_owner | Grant platform role |
| DELETE | `/owner/platform-admins/:userId` | platform_owner | Revoke platform role |

### Tenant workspace (iOS JWT + tenant membership required)

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/workspace/me` | tenant member+ | Current user + active tenant + role |
| GET | `/workspace/tenants` | tenant member+ | Tenants this user belongs to (switcher) |
| GET | `/workspace/profile` | tenant member+ | Caller's profile fields |
| PATCH | `/workspace/profile` | tenant member+ | Update **only** caller's row |
| GET | `/workspace/members` | tenant_admin | Members of caller's active tenant |
| GET | `/workspace/books` | tenant member+ | (Phase 2 stub) per-tenant books |
| GET | `/workspace/usage` | tenant member+ | Caller's today spend |

### Legacy routes

**All existing `/api/*`, `/api/v1/*`, `/webhooks/*`, `/waitlist/*`, `/health`, `/oauth/*/callback`, and the admin SPA at `/`, `/admin`, `/portal` continue to work UNCHANGED.**

---

## 8. Permission model added

Server-side enforcement in two middleware chains:

**`/owner/*` chain:**
1. `resolvePlatformAdmin` — reads `X-Admin-User-Id` header (or `?_asAdmin=N` debug), looks up `platform_admins.user_id`, attaches `req.platformAdmin = { userId, role }`. Fail-closed on DB error.
2. `requirePlatformOwner` — destructive ops (grant platform role, delete tenant).
3. `requirePlatformWrite` — any mutation; rejects `platform_readonly`.

**`/workspace/*` chain:**
1. `authMiddleware` (existing iOS JWT middleware — reused, not reimplemented).
2. `resolveTenantContext` — reads `X-Tenant-Id` header (numeric or `user-<id>` slug), falls back to solo tenant, verifies membership, attaches `req.tenantContext = { tenantId, tenant, role, joinedAt }`. Rejects suspended (423) or archived (423 on mutation, allows GET). Fail-closed on DB error.
3. `requireTenantAdmin` — tenant-local admin actions (invite, tenant settings).
4. `requireTenantWrite` — any mutation; rejects `tenant_viewer`.

All checks are **server-enforced**, with stable error codes (`UNAUTHORIZED`, `NOT_A_PLATFORM_ADMIN`, `INSUFFICIENT_PLATFORM_ROLE`, `NOT_A_MEMBER`, `INSUFFICIENT_TENANT_ROLE`, `TENANT_SUSPENDED`, `TENANT_ARCHIVED`, `TENANT_NOT_FOUND`).

---

## 9. Data model / migration changes

**Migration 076 adds 3 tables:**

- `tenants (id, slug, display_name, status, plan, created_at, created_by, metadata_json)` — status ∈ {active, suspended, archived, trial}, plan ∈ {free, pro, max, owner, beta}.
- `tenant_members (tenant_id, user_id, role, joined_at, invited_by)` — PK on (tenant_id, user_id); role ∈ {tenant_admin, tenant_member, tenant_viewer}.
- `platform_admins (user_id, role, granted_at, granted_by)` — role ∈ {platform_owner, platform_admin, platform_readonly}.

**Backfill (idempotent, strictly additive):**
- Every existing `users.id` is inserted into `tenants` with `id == users.id`, `slug = 'user-<id>'`, `plan = users.tier`. No-op if row already exists.
- Each gets a `tenant_members` row with `role = 'tenant_admin'`.
- The first `users` row with `tier = 'owner'` (ordered by id) is seeded into `platform_admins` as `platform_owner`.

All inserts use `INSERT OR IGNORE`. Safe to re-run. No existing column/table is modified. No FK added to `users`, `subscriptions`, `audit_trail`, or any other existing table — they continue to key by `user_id` as before. See the migration file's opening comment for the full backward-safety argument.

---

## 10. Tests added / updated

**New:** 74 tests across 5 files, all passing.

**Key isolation guarantees pinned:**
- A user can't access another user's solo tenant via `X-Tenant-Id` (→ 403 `NOT_A_MEMBER`). Test `rejects alice trying to enter bob's tenant via X-Tenant-Id`.
- `PATCH /workspace/profile` can only update the caller's row. Test verifies Bob's row is untouched after Alice's PATCH.
- `GET /workspace/members` lists only the caller's tenant's members, never cross-tenant. Test asserts bob is NOT in alice's member list.
- Suspended tenant rejects all traffic; archived allows GET only.
- `PATCH /owner/tenants/:id` writes `audit_trail` with `actor_id = real platform admin userId` (not 0). Test verifies the DB row.
- `POST /owner/platform-admins` rejects `platform_admin` (only `platform_owner` can grant) → 403 `INSUFFICIENT_PLATFORM_ROLE`.
- Platform admin seed is orthogonal to tenant membership (a platform admin with no tenant memberships works).
- Migration 076 backfill is idempotent — re-running doesn't create duplicate memberships.

---

## 11. Local validation steps + results

```bash
# In the worktree:
cd /tmp/nexus-portal-redesign

# 1. Typecheck
npx tsc --noEmit              # → clean ✅

# 2. Run ONLY the new test files
npx vitest run \
  __tests__/services/tenant-service.test.ts \
  __tests__/api/platform-admin-guard.test.ts \
  __tests__/api/tenant-context-guard.test.ts \
  __tests__/api/portal-owner-router.test.ts \
  __tests__/api/portal-workspace-router.test.ts
# → 74/74 pass ✅

# 3. Full suite (confirms legacy untouched)
npx vitest run
# → 4840/4842 pass (2 pre-existing failures in content-intelligence-*
#   tests that fail at the baseline too — unrelated to this branch)

# 4. Smoke the migration against a fresh in-memory DB
node -e "
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  const fs = require('fs');
  db.exec(fs.readFileSync('migrations/051_multi_auth_users.sql', 'utf8'));
  db.exec(fs.readFileSync('migrations/076_tenants_and_memberships.sql', 'utf8'));
  console.log('tables:', db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tenants','tenant_members','platform_admins')\").all());
"
```

---

## 12. Rollback steps

Three levels of rollback, in increasing blast radius:

```bash
# (a) Drop just the new tables — code keeps running; the /owner/* and /workspace/* mounts
#     will log a warn and no-op because tenant-service throws on missing tables.
sqlite3 data/nexus.db <<'SQL'
  DROP TABLE IF EXISTS tenant_members;
  DROP TABLE IF EXISTS platform_admins;
  DROP TABLE IF EXISTS tenants;
  DELETE FROM _migrations WHERE filename = '076_tenants_and_memberships.sql';
SQL

# (b) Abandon the feature branch (leave tables in place but remove the code).
#     The 3 tables are orphaned but harmless — no other code reads them.
git checkout main
git branch -D feature/nexus-hub-owner-workspace-separation

# (c) Full rollback to the pre-branch state.
git checkout main
git reset --hard backup/pre-owner-workspace-split-20260422-1544
# Then run (a) to clean up the DB.
```

The feature is **strictly additive**: no existing table was modified, no existing handler changed, no existing test was altered in a way that removes coverage. The worst-case rollback is zero-data-loss.

---

## 13. Open risks

1. **`/owner/*` has NO token check of its own.** It relies on `X-Admin-User-Id` + `platform_admins` row only. In production, the recommendation is to keep the legacy `/api/*` portal-token middleware in front of admin traffic until a proper admin login session lands in Phase 2. Exposing `/owner/*` on the public cloudflare tunnel without a token is unsafe until then.
2. **iOS doesn't speak `/workspace/*` yet.** The iOS client continues to use `/api/v1/*`. Phase 3 adds the `X-Tenant-Id` header and teaches iOS to prefer `/workspace/*` for user-scoped resources.
3. **Platform-admin bootstrap on fresh environments.** The migration seeds `platform_owner` only if a `tier='owner'` user exists at migration time. Brand-new installs won't have one → `/owner/*` will 403 until an owner user is created and re-run of migration 076 re-seeds the row. Documented in the migration's comment.
4. **Portal SPA (`portal.html`) still only speaks `/api/*`.** It won't exercise any `/owner/*` endpoint until Phase 3 updates it (or we build a separate owner SPA).
5. **Multi-member tenants have no invite flow yet.** `tenant_members` has an `invited_by` column but no endpoint populates it. Phase 2 adds `POST /workspace/members` (tenant_admin-only) with an invite token path.
6. **Feature entitlements still read from `users.tier`.** `tenants.plan` is populated and ready for `plan-quotas.ts` to consume, but the cutover happens in Phase 2 with tests verifying parity.
7. **Full user account + tenant suspension semantics** are defined in the schema but only partially enforced (workspace blocks suspended-tenant traffic; nothing yet reads `users.status === 'suspended'` in the new guards).

---

## 14. Recommended next improvements (prioritized)

**Phase 2 (route migration + workspace backing)** — est. 2–3 passes:

1. Replace every `actorId: 0` in `portal/server.ts` with `req.platformAdmin.userId` once the owner SPA uses `/owner/*` mutations.
2. Add a `tenant_books` table (migration 077) and wire `/workspace/books` to real storage — the existing `/api/books` endpoint + `config_seed_books` stays for the legacy admin library.
3. Add `/workspace/content` + `/workspace/links` endpoints with tenant-scoped CRUD over existing `content_knowledge` / `content_references` tables (add `tenant_id` column if not already implicit).
4. Migrate `plan-quotas.ts` + entitlement resolver to read plan from `tenants.plan` instead of `users.tier`. Keep a fallback to `users.tier` for a few weeks; then delete.
5. Replace the duplicate `GET /api/skills` with a single canonical registration.
6. Add `POST /workspace/members` (invite flow) + `DELETE /workspace/members/:userId` (tenant_admin only).
7. Harden `/owner/*` with a dedicated portal-admin token (new `PORTAL_OWNER_CONSOLE_TOKEN` env) — keep the `X-Admin-User-Id` check on top.

**Phase 3 (UI split + iOS migration)** — est. 2 weeks:

1. Split `portal.html` into `portal-owner.html` (current admin tabs) and `portal-workspace.html` (new user console with books/content/links/profile/members).
2. Implement a proper admin login session (cookie-based, with CSRF + session-expiry) to replace the static admin-token model.
3. Add `X-Tenant-Id` support to the iOS auth flow; default to solo tenant; add tenant switcher in iOS Settings.
4. Teach iOS to prefer `/workspace/*` for user-scoped reads; keep `/api/v1/*` for AI-backed turns.

**Phase 4 (operational maturity)**:

1. Feature entitlements per tenant (`tenant_entitlements` table) independent of `plan`.
2. Soft-delete + archival flows with a tenant-admin-visible "request deletion" button.
3. Tenant data export (GDPR-grade JSON bundle).
4. Real admin audit timeline on `/owner/tenants/:id` — query `audit_trail WHERE user_id = tenantId OR resource LIKE 'tenant.$id%'`.
5. Usage-chart-on-tenant-detail (cost & token rolled up per plan + daily).

---

## 15. Additional SaaS improvements discovered during the work

Surfaced but **not implemented** on this branch (documented for a later pass):

1. **`audit_trail.actor_id = 0` across ~6 legacy portal mutations.** The owner router demonstrates the fix; Phase 2 walks the legacy `/api/*` routes and threads the admin userId through.
2. **The warm-cache path hardcodes owner** (`server.ts:1237-1242`). Once multi-tenant is live, every active tenant should warm their own dashboard + tasks caches, prioritized by last activity.
3. **`/api/audit-trail`** returns every tenant's rows to any portal-token holder. Phase 2 replaces with `/owner/audit?tenantId=N` (owner-scope) and `/workspace/audit` (tenant-scope, me-only).
4. **No rate-limit on `/owner/*` yet.** The existing `rateLimitMiddleware` is IP-bucketed and applies to `/auth/*`. Phase 2 mounts it on `/owner/*` with a stricter platform-admin cap.
5. **PR-review / impersonation tooling** is specifically called out as dangerous in the spec. Not implemented. Left as a deliberate-gap note: any future impersonation must be a time-bounded, audited, explicit operation distinct from normal admin actions.
6. **Slug uniqueness on `tenants.slug`** is currently `UNIQUE`. If future Phase 3 allows custom slugs (e.g. `acme-corp`), validation needs to block reserved words (`admin`, `api`, `workspace`, `owner`, ...).
7. **Platform-admin grant doesn't check the target user's tenant status.** A suspended user could be granted platform_admin. Phase 2 should add a status check in the grant endpoint.
8. **Setup.ts env additions are a minor footprint change.** The 4 env vars (`IOS_API_ENABLED`, `IOS_API_JWT_SECRET`, `IOS_INVITE_CODE`, `IOS_OWNER_CODE`) get defaults so any test using iOS JWT auth works out of the box. Defaults are overridable (only set if unset). One test (`portal-token-strength`) adjusted to explicitly disable iOS for its scope.

---

## 16. Final verdict

**Ship-ready for local review. Do NOT push to `origin` or deploy.** The branch delivers the foundation for a real multi-tenant portal:

- Proper `tenants` + `tenant_members` + `platform_admins` schema with idempotent backfill.
- Two separate, clearly-gated API surfaces (`/owner/*` cross-tenant, `/workspace/*` tenant-scoped).
- Server-enforced RBAC with stable error codes + audit-trail actor id.
- 74 new passing tests pinning the isolation guarantees.
- Zero existing behavior changed; 4840/4842 tests pass (the 2 failures are pre-existing and unrelated).
- Comprehensive rollback path with zero data loss.
- Phased plan in the redesign doc for everything not in this slice.

The next step is **human review of the branch**, then merge to `main` with `--ff-only` after coordination with Codex on the WIP in the main working tree (scoped tokens, cache invalidator extractions), then plan Phase 2.
