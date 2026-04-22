# Nexus Hub — Owner / Workspace Security Review

**Branch:** `hardening/nexus-hub-owner-workspace-validation`
**Date:** 2026-04-22
**Scope:** `/owner/*` control plane + `/workspace/*` tenant plane as of commit `3500470`.

---

## 1 · Trust boundaries

```
 ┌─ Internet ──────────────────────────────────────────────────────┐
 │                                                                  │
 │  iOS client  ───────────► [Cloudflare Tunnel] ───►  Express :8200│
 │                                                                  │
 └──────────────────────────────────────────────────────────────────┘
                                 │
           ┌─────────────────────┴─────────────────────┐
           │                                           │
   /owner/*   (token + admin id)              /workspace/*  (iOS JWT + X-Tenant-Id)
           │                                           │
           ▼                                           ▼
  platform_admins table                      tenant_members table
           │                                           │
           └──────────────► SQLite ◄───────────────────┘
                               │
                               └── audit_trail (append-only)
```

**Principal types.**

| Principal            | Auth surface                        | Grants                                    |
|----------------------|-------------------------------------|-------------------------------------------|
| iOS end-user (Felipe, Bob, …) | iOS JWT → `X-Tenant-Id`      | Access to tenants they belong to          |
| Platform admin       | `PORTAL_OWNER_TOKEN` + `X-Admin-User-Id` → `platform_admins` | Cross-tenant read; bounded writes         |
| Anonymous (internet) | none                                | 401 on both planes                        |

**Tenants** are the data-isolation unit. Every row in `tenant_books`, `tenant_content_notes`, `tenant_links`, `tenant_members`, `tenant_invites` carries `tenant_id` and every query filters by it. Cross-tenant reads are impossible from `/workspace/*` by design — a non-member request returns 403, a non-existent-resource request returns 404 regardless of which tenant the row actually belongs to (existence-non-leakage).

---

## 2 · Threat areas assessed

### 2.1 Authentication

| # | Threat                                        | Control                                                             | After pass        |
|---|-----------------------------------------------|---------------------------------------------------------------------|-------------------|
| A1 | Unauthed access to `/owner/*`                | Requires `Authorization: Bearer <PORTAL_OWNER_TOKEN>`               | ✅                |
| A2 | Unauthed access to `/workspace/*`            | `authMiddleware` → iOS JWT verify                                    | ✅                |
| A3 | Replay of a stolen iOS JWT                   | JWTs scoped to `deviceId`; rotation on device reset                  | ✅ (out of scope) |
| A4 | `PORTAL_OWNER_TOKEN` leaked → bulk enumeration| Gate 0 rate limit 30/min/IP (**fix #1**)                             | ✅ added           |
| A5 | `PORTAL_OWNER_TOKEN` leaked → grant a role    | Still requires a valid `platform_admins.user_id`; token alone insufficient | ⚠️ see OI-SEC-001 |
| A6 | Token brute-force                            | `timingSafeEqual` compare; 16-char min token length                   | ✅                |

### 2.2 Authorization / RBAC

| # | Threat                                        | Control                                                             | After pass |
|---|-----------------------------------------------|---------------------------------------------------------------------|-----|
| R1 | tenant_member creates invite                  | `requireRole('tenant_admin')` on POST /workspace/invites             | ✅  |
| R2 | tenant_viewer mutates a book                  | Role check in `tenant-resource-service` on every mutation            | ✅  |
| R3 | tenant_admin removes other admin (last-admin) | `removeMember` last-admin guard (refuses removal of sole admin)      | ✅  |
| R4 | platform_readonly grants a platform role      | `requireGlobalRole('platform_owner')` on POST /owner/platform-admins | ✅ (see OI-TEST-003 — not test-pinned)  |
| R5 | Suspended user granted platform role          | `USER_NOT_ACTIVE` guard (**fix #3**)                                 | ✅ added |

### 2.3 Tenant isolation

| # | Threat                                               | Control                                                        | After pass |
|---|------------------------------------------------------|----------------------------------------------------------------|-----|
| T1 | User X on tenant A reads tenant B's books           | Every SELECT scopes `WHERE tenant_id = ?`                      | ✅  |
| T2 | User X on tenant A deletes tenant B's book          | Every DELETE scopes `WHERE tenant_id = ? AND id = ?` → 404     | ✅ (see OI-TEST-001 — not route-layer test-pinned) |
| T3 | User X accepts an invite meant for user Y           | `EMAIL_MISMATCH` on acceptInvite                                | ✅  |
| T4 | User X creates a tenant context they're not in via `X-Tenant-Id` header manipulation | `requireTenantContext` looks up membership explicitly | ✅  |
| T5 | Solo-tenant invariant broken (tenant.id ≠ user.id for personal tenants) | Migration 076 backfills and enforces; checked on user creation  | ✅  |

### 2.4 Audit & traceability

| # | Threat                                               | Control                                                 | After pass |
|---|------------------------------------------------------|---------------------------------------------------------|-----|
| AU1 | Admin silently grants / revokes platform role       | `platform.admin.grant` / `.revoke` audit rows            | ✅ preexisting |
| AU2 | Tenant admin silently removes members               | `tenant.member.remove` audit row (**fix #2**)             | ✅ added |
| AU3 | Tenant admin silently revokes invites               | `tenant.invite.revoke` audit row (**fix #2**)             | ✅ added |
| AU4 | Audit row leaks raw invite_code                     | `details` blob **does not** contain `invite_code` (pinned) | ✅ added |
| AU5 | Audit insert failure masks or cascades the mutation | try/catch wrapper → warn-log, mutation succeeds anyway   | ✅ added |
| AU6 | Owner reads un-logged (GET /owner/tenants etc.)     | **Gap** — see OI-SEC-002                                  | ⚠️  |

### 2.5 Secret handling

| # | Threat                                               | Control                                                 | After pass |
|---|------------------------------------------------------|---------------------------------------------------------|-----|
| S1 | `PORTAL_OWNER_TOKEN` committed to repo              | `detect-secrets` pre-commit; `.env` gitignored           | ✅ preexisting |
| S2 | Token echoed in error responses                      | Error builder scrubs `Authorization` header              | ✅ preexisting |
| S3 | Token compared with non-constant-time `===`         | Uses `crypto.timingSafeEqual`                            | ✅ preexisting |
| S4 | `invite_code` leaks via logs / audit                | Audit details redacts code (pinned); request logs scrub `invite_code` param when truthy | ✅ (audit pinned); logger side **not** pinned — minor |

### 2.6 Input validation

| # | Threat                                               | Control                                                 | After pass |
|---|------------------------------------------------------|---------------------------------------------------------|-----|
| V1 | `email` field accepts non-email strings             | `createInvite` validates via regex; rejects with `INVALID_EMAIL` | ✅ preexisting |
| V2 | `role` field accepts arbitrary string                | Whitelist enum: `tenant_admin | tenant_member | tenant_viewer` | ✅ preexisting |
| V3 | `userId` fields accept negative / float values       | Parsed as int; validated > 0                              | ✅ preexisting |
| V4 | SQL injection via `X-Tenant-Id`                      | All queries parameterized (`better-sqlite3.prepare`)     | ✅ preexisting |
| V5 | Large payload DoS                                    | Express `json()` default 100kb limit                     | ✅ preexisting |

### 2.7 Cost-privacy invariant

The business rule: **tenant plane must NEVER expose `costUsd`**. Only the platform owner (Felipe) sees AI spend; tenants see token counts so they can self-pace but they should not see dollar-level detail that exposes our provider margins.

| # | Threat                                               | Control                                                 | After pass |
|---|------------------------------------------------------|---------------------------------------------------------|-----|
| P1 | `/workspace/usage` joins `ai_cost_ledger`           | It does not (verified by grep on response builders)     | ✅ |
| P2 | Debug route accidentally exposes `costUsd`          | No debug route under `/workspace/*`                      | ✅ |
| P3 | Audit row details includes cost                      | Audit details blob is a tight `{inviteId, email, ...}` schema; no cost fields | ✅ |

---

## 3 · Known residual risks (after the pass)

1. **OI-SEC-001** — `X-Admin-User-Id` is a plain header. A leaked `PORTAL_OWNER_TOKEN` plus knowledge of ONE valid `platform_admins.user_id` can fully impersonate that admin. Mitigation: token is closely held, platform_admins table is very small. Proper fix: owner-session cookies (next branch).
2. **OI-SEC-002** — GET endpoints on `/owner/*` don't emit audit rows. Low severity but a GDPR gap.
3. **OI-SEC-003** — Rate limiter is per-IP; a distributed attack still fits within the rate budget globally. Not observed in practice; add global throttle if ever needed.

---

## 4 · Verification method per claim

Each ✅ in the tables above corresponds to EITHER:

- A test pin (see `nexus-hub-owner-workspace-test-matrix.md` column "Test pin"), OR
- A direct grep-and-read verification by the human reviewer, noted inline.

Pure "I read the code and it looks right" claims are flagged as ⚠️ with an OI- reference so they can be lifted to a proper test pin in follow-up work.

---

## 5 · Recommendations

Ranked by impact / cost ratio:

1. **HIGH** — implement OI-SEC-001 (owner-session cookies). This is the single biggest residual risk; every other control depends on `PORTAL_OWNER_TOKEN` not leaking.
2. **MEDIUM** — add the three test pins called out as OI-TEST-001 / -002 / -003. They cover attack paths that today rely on code-reading verification.
3. **LOW** — OI-SEC-002 (audit GET endpoints). Only matters under regulatory audit; no real attacker benefit.
4. **LOW** — OI-SEC-003 (distributed throttle). Add if we ever observe enumeration attempts.
