# Nexus Hub — Owner / Workspace Open Items

**Branch:** `hardening/nexus-hub-owner-workspace-validation`
**Date:** 2026-04-22
**Companion docs:** `nexus-hub-owner-workspace-validation-report.md` (what was fixed),
`nexus-hub-owner-workspace-security-review.md` (deeper security context).

---

## Legend

- **P0** — user-visible security / correctness bug. Block release.
- **P1** — hardening or UX debt. Should land before the next public cut.
- **P2** — nice-to-have, track but not urgent.
- **Pre-existing** — already on `main` / baseline commit `3500470`; not introduced on this branch. Flagged for the team, **not** owned by this pass.

---

## 1 · Security & access-control

### OI-SEC-001 — `X-Admin-User-Id` is header-trusted on `/owner/*` [P1]

**Where.** `src/api/platform-admin-guard.ts > identifyAdmin()` reads `req.headers['x-admin-user-id']` and looks up `platform_admins.user_id`. There is no signed session / JWT / proof-of-possession — any caller with the token can claim any admin id.

**Why this branch didn't fix it.** Out of scope for a hardening pass — requires a new `/owner/login` flow that issues a short-lived signed session cookie tied to the iOS login or a separate owner-console credential. Non-trivial surface change.

**Mitigation today.** Gate 0 rate limit (fix #1) blocks bulk enumeration; `PORTAL_OWNER_TOKEN` still acts as the first-factor shared secret. A leaked token alone cannot grant platform roles without ALSO knowing a valid `platform_admins.user_id` — small set, but not zero.

**Recommended next step.** Issue a signed `X-Owner-Session` cookie on successful login (owner-token + ownerUserId + a second factor). Reject `X-Admin-User-Id` when a valid cookie is present, and remove the header path entirely in a follow-up.

---

### OI-SEC-002 — No audit row on GET `/owner/tenants`, `/owner/users`, `/owner/usage` [P2]

**Where.** Owner console READ endpoints. Mutations are audited (platform_admin grant/revoke write rows) but bulk reads of the tenant/user/usage namespace are not.

**Why this matters.** A curious admin can scrape the entire tenant namespace (names, slugs, plans) without leaving a trail. Low severity because `platform_admins` is tightly scoped, but for GDPR compliance in a multi-customer product it's a gap.

**Recommended.** Emit a single `platform.admin.read` audit row per request (not per row returned) with `{route, resultCount}`.

---

### OI-SEC-003 — Distributed enumeration possible despite Gate 0 [P2]

**Where.** `ownerRateLimitMiddleware` keys on `extractClientIp(req)`. A botnet with N IPs can make 30×N requests/min and bypass the cap.

**Mitigation today.** `PORTAL_OWNER_TOKEN` unknown to attackers = 0 successful probes (every request still 401s at Gate 1). Gate 0 only matters on the leaked-token branch.

**Recommended.** If a distributed attack is ever observed, add a global rate limit on `/owner/*` (e.g. 600 req/min across all IPs) that trips an ops alert, plus optionally drop requests where the token check fails 10+ times from the same IP (exponential backoff).

---

## 2 · Correctness

### OI-COR-001 — `/workspace/usage` does not surface aggregated tenant usage [P1]

**Where.** The workspace demo shows per-user token counts but no per-tenant roll-up across all members.

**Why it matters.** A tenant with 3 members wanting to see "our total usage this month" can't get that number from the workspace plane — they'd have to sum the three individual responses manually.

**Recommended.** Add `GET /workspace/usage/tenant` that roll-ups `ai_usage` by tenant_id (still without `costUsd` — preserve the cost-privacy invariant). Gate on `tenant_admin` role.

---

### OI-COR-002 — Remove-member does not cascade `tenant_resources` authorship [P2]

**Where.** `removeMember` in `tenant-service` deletes the `tenant_members` row but leaves rows in `tenant_books` / `tenant_content_notes` / `tenant_links` where `author_user_id` is the removed user. Those rows remain tenant-scoped (they don't orphan) but the UI still shows "by: ex-member@e.com" which can be confusing.

**Recommended.** On remove, either (a) set `author_user_id = NULL` and display "(removed user)" in the UI, or (b) reassign to the removing admin. Decision pending product call.

---

### OI-COR-003 — No optimistic concurrency on resource updates [P2]

**Where.** `PATCH /workspace/books/:id`, `/content/:id`, `/links/:id` accept the new value blindly. Two admins editing the same book row simultaneously: last write wins, no conflict signal.

**Recommended.** Add `updated_at` to the request body; reject with 409 if the stored value doesn't match. Low priority given the audience size.

---

## 3 · Observability

### OI-OBS-001 — No `correlation_id` on owner responses [P2]

**Where.** `/owner/*` responses don't echo a `X-Request-Id` / `X-Correlation-Id` that the client can pair with server logs. When a platform admin sees "500 Internal Server Error" there's no handle to trace it.

**Recommended.** Wire `src/utils/request-context.ts > reqId` into a response header on every /owner/* and /workspace/* route.

---

### OI-OBS-002 — Rate-limit throttles aren't counted in a metric [P2]

**Where.** Every 429 from `ownerRateLimitMiddleware` is a security signal worth counting. Today it only shows in logs.

**Recommended.** Increment a `portal.owner.rate_limited.count` counter; alert if > N/min sustained.

---

## 4 · UX / usability

### OI-UX-001 — Workspace invite form has no "copy invite link" button [P1]

**Where.** `workspace-ui.html` — after creating an invite, the raw `invite_code` is shown in a table cell but there's no one-click copy and no "share this URL" pattern.

**Recommended.** Add a button that copies `${location.origin}/invite/accept?code=${inviteCode}` to the clipboard. Also add a truncated preview so the raw code isn't shouted across the UI.

---

### OI-UX-002 — No in-UI countdown for invite expiry [P2]

**Where.** Invites have `expires_at` but the workspace UI doesn't surface it. Users don't know how long their invite is valid.

**Recommended.** Show "expires in Xh" next to each pending invite; flip to "expired" styling once past.

---

### OI-UX-003 — Book-status badge now has colors but dropdown still shows raw enum values [P2]

**Where.** After fix #5 the badge is colored correctly, but the edit dropdown still lists `want_to_read` / `reading` / `finished` / `abandoned` as raw snake_case labels. Should be "Want to read" / "Reading" / "Finished" / "Abandoned".

**Recommended.** Add a label map (same pattern as the existing role labels).

---

## 5 · Test coverage gaps

### OI-TEST-001 — No e2e test for cross-tenant resource DELETE leakage [P1]

**Where.** `tenant-resource-service` scopes all DELETEs by `tenant_id` — this is believed-correct but not pinned end-to-end at the route layer. Specifically: user X on tenant A tries `DELETE /workspace/books/:id` where `:id` belongs to tenant B → should 404 (never 403, per the existence-non-leakage rule).

**Recommended.** Add a test in `__tests__/api/portal-workspace-resource-routes.test.ts` that seeds two tenants, attempts a cross-tenant delete, and expects 404.

---

### OI-TEST-002 — No test for last-admin protection on `removeMember` via HTTP [P1]

**Where.** `tenant-service.removeMember` has the last-admin guard; the service-layer test covers it, but the route-layer test doesn't verify the 400 is surfaced to the client correctly.

**Recommended.** Extend `portal-workspace-router.test.ts` with: seed tenant with 1 admin + 1 member, admin tries to remove themselves, expect 400 `LAST_ADMIN`.

---

### OI-TEST-003 — No test for `POST /owner/platform-admins` RBAC (can a `platform_readonly` call it?) [P1]

**Where.** Only `platform_owner` should be able to grant platform roles. The guard is in place (I read the code) but it's not test-pinned.

**Recommended.** Add a test: seed a `platform_readonly` user, try the POST, expect 403 `FORBIDDEN`.

---

## 6 · Pre-existing failures (not introduced by this branch)

### PRE-EX-001 — `content-intelligence-detail.test.ts` failing [baseline]

**Where.** `__tests__/api/content-intelligence-detail.test.ts:247` — `discovery.recentSignals` expected length 1, received empty array.

**Confirmed pre-existing.** Fails identically on baseline commit `3500470` (checked out `src/` at that ref, re-ran tests, same failure).

**Owner.** Content-intelligence team — not this hardening pass.

---

### PRE-EX-002 — `content-intelligence-summary.test.ts` failing [baseline]

**Where.** `__tests__/api/content-intelligence-summary.test.ts:218` — `discovery.activeCount` expected 1, received 0.

**Confirmed pre-existing.** Same as PRE-EX-001 — fails on baseline.

**Owner.** Content-intelligence team.

---

## 7 · Deferred / nice-to-have

- **OI-DEF-001** — Owner-console HTML lives in `src/portal/owner-ui.html` as a stand-alone file; consider merging with the existing portal SPA or moving to a proper React/Svelte component.
- **OI-DEF-002** — `platform_admins.granted_at` is a TEXT column with no index. Low traffic today; add an index if the admin count ever grows past ~1k.
- **OI-DEF-003** — No equivalent of `/workspace/my-invites` for the owner plane: a new platform_admin who hasn't logged in yet can't see they were granted a role. Edge case.
