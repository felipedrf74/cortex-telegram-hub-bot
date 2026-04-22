# Nexus Hub — Owner / Workspace Test Matrix

**Branch:** `hardening/nexus-hub-owner-workspace-validation`
**Date:** 2026-04-22
**Purpose:** Per-flow expected-vs-actual map for every route that was in scope during the validation pass. Used as the readiness checklist.

Columns:
- **Flow** — user-visible operation.
- **Route / service** — the server surface.
- **Expected** — the contract as specified in the design doc.
- **Actual (before fix)** — what the code did on 2026-04-22 before the pass.
- **Actual (after fix)** — current state.
- **Test pin** — file:line that fails if this ever regresses.

---

## 1 · Owner control plane — `/owner/*`

| # | Flow | Route | Expected | Actual (before) | Actual (after) | Test pin |
|---|------|-------|----------|-----------------|----------------|----------|
| O1 | Unauthed request with no token | `GET /owner/tenants` | 401 `NO_OWNER_TOKEN` | ✅ same | ✅ same | `__tests__/api/portal-owner-router.test.ts` (preexisting) |
| O2 | Wrong token | `GET /owner/tenants` with bogus bearer | 401 `INVALID_OWNER_TOKEN` | ✅ same | ✅ same | preexisting |
| O3 | Valid token, missing `X-Admin-User-Id` | `GET /owner/tenants` | 401 `NO_ADMIN_IDENTITY` | ✅ same | ✅ same | preexisting |
| O4 | Valid token + id but user not in `platform_admins` | `GET /owner/tenants` | 403 `NOT_PLATFORM_ADMIN` | ✅ same | ✅ same | preexisting |
| O5 | Per-IP rate limit under budget | 30× `GET /owner/tenants` in 60 s | All 200 | ❌ No rate limit at all | ✅ 200 × 30 | `portal-owner-hardening.test.ts:147` |
| O6 | Per-IP rate limit at budget | 31st request | 429 `RATE_LIMITED` + `Retry-After` | ❌ 200 (no throttle) | ✅ 429 + header | `portal-owner-hardening.test.ts:147` |
| O7 | Rate limit runs BEFORE token | 30× wrong tokens, then 1× correct | 31st request 429 | ❌ 30× 401 then 1× 200 (leak) | ✅ 31st 429 | `portal-owner-hardening.test.ts:160` |
| O8 | Response tagged with rate-limit bucket | `GET /owner/tenants` | `X-RateLimit-Bucket: owner` header | ❌ Header absent | ✅ Present | `portal-owner-hardening.test.ts:141` |
| O9 | Grant platform_admin — active user | `POST /owner/platform-admins { userId, role }` | 201 + row in `platform_admins` | ✅ same | ✅ same | `portal-owner-hardening.test.ts:194` |
| O10 | Grant to suspended user | `POST ...` | 400 `USER_NOT_ACTIVE` | ❌ 201 (granted anyway) | ✅ 400 + no row | `portal-owner-hardening.test.ts:204` |
| O11 | Grant to banned user | `POST ...` | 400 `USER_NOT_ACTIVE` | ❌ 201 | ✅ 400 | `portal-owner-hardening.test.ts:218` |
| O12 | Grant to non-existent user | `POST ...` | 404 `USER_NOT_FOUND` | ✅ same | ✅ same | `portal-owner-hardening.test.ts:228` |
| O13 | List tenants | `GET /owner/tenants` | All tenants across platform | ✅ | ✅ | preexisting |
| O14 | List users by tier filter | `GET /owner/users?tier=pro` | Filtered set | ✅ | ✅ | preexisting |
| O15 | Owner usage surfaces `costUsd` | `GET /owner/usage` | Response includes `costUsd` per row | ✅ | ✅ | preexisting (by contract) |
| O16 | Tenant plane never surfaces `costUsd` | Grep on `/workspace/*` response builders | No `costUsd` key anywhere | ✅ | ✅ | `portal-workspace-router.test.ts` (cost-privacy pin) |

---

## 2 · Tenant workspace — `/workspace/*`

| # | Flow | Route | Expected | Actual (before) | Actual (after) | Test pin |
|---|------|-------|----------|-----------------|----------------|----------|
| W1 | Unauthed request | `GET /workspace/me` | 401 `UNAUTHORIZED` | ✅ | ✅ | preexisting |
| W2 | JWT valid, no `X-Tenant-Id` — solo tenant | `GET /workspace/me` | Falls back to user's personal tenant (id == userId) | ✅ | ✅ | `portal-workspace-router.test.ts` |
| W3 | JWT valid, `X-Tenant-Id` names a tenant user is NOT a member of | `GET /workspace/me` | 403 `NOT_A_MEMBER` | ✅ | ✅ | `portal-workspace-router.test.ts` |
| W4 | Create invite — tenant_admin | `POST /workspace/invites` | 201 + `invite_code` | ✅ | ✅ | `portal-workspace-invite-routes.test.ts` |
| W5 | Create invite — tenant_member | `POST ...` | 403 `FORBIDDEN` | ✅ | ✅ | `portal-workspace-invite-routes.test.ts` |
| W6 | Invite creation writes audit row | after W4 | `audit_trail` has `tenant.invite.create` | ❌ No audit row | ✅ Row present | `portal-workspace-audit.test.ts:175` |
| W7 | Invite audit row MUST NOT carry raw code | after W4 | `details` does not contain `invite_code` | ❌ (would leak if log were re-added naively) | ✅ Pinned | `portal-workspace-audit.test.ts:183` |
| W8 | Revoke invite | `DELETE /workspace/invites/:id` | 200 + status='revoked' | ✅ | ✅ | preexisting |
| W9 | Revoke writes audit row | after W8 | `audit_trail` has `tenant.invite.revoke` | ❌ No audit row | ✅ Row present | `portal-workspace-audit.test.ts:192` |
| W10 | Accept invite — correct email | `POST /workspace/my-invites/:code/accept` | 200 + membership row | ✅ | ✅ | `portal-workspace-invite-routes.test.ts` |
| W11 | Accept writes audit row w/ acceptor as actor | after W10 | `audit_trail` has `tenant.invite.accept` with actor=acceptor | ❌ No audit row | ✅ Row + correct actor | `portal-workspace-audit.test.ts:207` |
| W12 | Accept — wrong email | `POST ...` | 403 `EMAIL_MISMATCH` | ✅ | ✅ | `tenant-invite-service.test.ts` |
| W13 | Accept — expired invite (ISO-8601 input) | `POST ...` with `expires_at` in past as `.toISOString()` | Throws `EXPIRED`, row marked | ❌ Flaky (TZ-dependent); first fix iteration broken | ✅ Throws EXPIRED | `tenant-invite-expiry-formats.test.ts:75` |
| W14 | Accept — expired invite (SQLite-native input) | `POST ...` with `expires_at = datetime('now', '-60 seconds')` | Throws `EXPIRED` | ✅ (was working) | ✅ Still working | `tenant-invite-expiry-formats.test.ts:90` |
| W15 | Accept — future-expiry does NOT mark expired | `POST ...` with `expires_at` in future | 200 + status='accepted' | ✅ | ✅ | `tenant-invite-expiry-formats.test.ts:107` |
| W16 | Accept — null expires_at (no expiry) | `POST ...` | 200 + accepted | ✅ | ✅ | `tenant-invite-expiry-formats.test.ts:128` |
| W17 | Remove member — tenant_admin removes tenant_member | `DELETE /workspace/members/:userId` | 200 + membership deleted | ✅ | ✅ | `portal-workspace-router.test.ts` |
| W18 | Remove member writes audit row | after W17 | `audit_trail` has `tenant.member.remove` | ❌ No audit row | ✅ Row present | `portal-workspace-audit.test.ts:163` |
| W19 | Remove LAST admin — self-remove | `DELETE /workspace/members/:me` when sole admin | 400 `LAST_ADMIN` | ✅ (service test only) | ✅ | `tenant-service.test.ts` — **needs route-layer pin (OI-TEST-002)** |
| W20 | Resource CRUD — book create | `POST /workspace/books` | 201 | ✅ | ✅ | `portal-workspace-resource-routes.test.ts` |
| W21 | Resource CRUD — cross-tenant DELETE | `DELETE /workspace/books/:id` where :id ∉ caller's tenant | 404 (existence non-leak) | ✅ (service test) | ✅ | **needs route-layer pin (OI-TEST-001)** |
| W22 | Workspace usage endpoint omits `costUsd` | `GET /workspace/usage` | Response has `tokensIn / tokensOut` but no `costUsd` | ✅ | ✅ | preexisting |
| W23 | Audit write failure doesn't break mutation | Drop `audit_trail`, call DELETE member | 200 (mutation succeeds) | N/A (no audit) | ✅ 200 | `portal-workspace-audit.test.ts:225` |

---

## 3 · UI (workspace demo)

| # | Flow | Expected | Actual (before) | Actual (after) | Test pin |
|---|------|----------|-----------------|----------------|----------|
| U1 | Book status badge — `want_to_read` | Distinct blue color | ❌ Same style as `accepted` | ✅ Distinct | manual visual |
| U2 | Book status badge — `reading` | Amber | ❌ Same as others | ✅ Distinct | manual visual |
| U3 | Book status badge — `finished` | Green | ✅ (matched `accepted` by accident) | ✅ Explicit class | manual visual |
| U4 | Book status badge — `abandoned` | Muted grey | ❌ Same as others | ✅ Distinct | manual visual |

---

## 4 · Cross-cutting contracts (invariants)

| # | Invariant | How pinned | File:Line |
|---|-----------|------------|-----------|
| C1 | `/owner/*` rate-limit always runs before token check | Request with wrong token burns budget | `portal-owner-hardening.test.ts:160` |
| C2 | Tenant audit `details` never contains raw invite_code | String non-containment assertion | `portal-workspace-audit.test.ts:183` |
| C3 | `acceptInvite` expiry compare is TZ-invariant on both format styles | 4 tests (ISO/SQL × past/future) | `tenant-invite-expiry-formats.test.ts` all |
| C4 | Audit failure is best-effort (mutation still succeeds) | `DROP TABLE audit_trail` then DELETE member | `portal-workspace-audit.test.ts:225` |
| C5 | Suspended/banned users cannot be granted platform roles | 2 tests (suspended + banned) | `portal-owner-hardening.test.ts:204,218` |

---

## 5 · Summary

- **Total new tests added on this branch:** 17 (7 owner-hardening + 5 audit + 5 expiry-formats)
- **All hardening-related tests green:** ✅ 37/37
- **Unrelated pre-existing failures:** 2 (content-intelligence-*), documented in `nexus-hub-owner-workspace-open-items.md`
- **Test pin gaps identified for follow-up:** 3 (OI-TEST-001, OI-TEST-002, OI-TEST-003)
