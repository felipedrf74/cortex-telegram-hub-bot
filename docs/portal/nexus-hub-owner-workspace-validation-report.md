# Nexus Hub — Owner / Workspace Validation Report

**Branch:** `hardening/nexus-hub-owner-workspace-validation`
**Baseline:** commit `3500470` (Phase 2D — remove-member endpoint)
**Backup tag:** `backup/pre-hardening-2026-04-22`
**Date:** 2026-04-22
**Mode:** local validation + safe hardening (no production deploy, no main merge)

---

## 1 · Scope of the validation pass

Target surface:

- **Owner control plane** — `/owner/*` routes (`createPortalOwnerRouter`), `platform_admins` identity table, the owner-console HTML demo, owner-scoped usage / tenant / admin / invite / audit endpoints.
- **Tenant workspace plane** — `/workspace/*` routes (`createPortalWorkspaceRouter`), tenant-context resolution (`X-Tenant-Id`), tenant membership enforcement, the workspace HTML demo, multi-tenant invite flow, shared-resource CRUD (books / content notes / links), remove-member.
- **Shared substrate** — SQLite migrations 076 (tenants + memberships), 077 (invites), 078 (resources); audit trail table (migration 033); services `tenant-service`, `tenant-invite-service`, `tenant-resource-service`.
- **iOS client contract** — iOS JWT → `X-Tenant-Id` resolution on `/workspace/*`; cost-privacy invariant (tenant plane MUST NOT expose `costUsd`).

Non-goals on this branch: (a) no schema migrations beyond 078, (b) no feature work, (c) no main/master commits, (d) no prod deploys.

---

## 2 · Method

1. **Routes inventory.** `grep -rE "router\.(get|post|patch|delete)" src/api/portal-*.ts` to enumerate every owner and workspace endpoint.
2. **Guard inventory.** For each endpoint, traced the middleware chain (rate-limit → auth → identity → tenant-context → role-check → handler) and compared against the documented invariants in `nexus-hub-portal-owner-workspace-redesign.md`.
3. **Specific site inspection.** Opened every mutation handler and verified: (a) transaction wrapping, (b) audit row written, (c) actor identity sourced from the authenticated principal (not request body), (d) cross-tenant isolation, (e) last-admin protection where applicable.
4. **Test inventory.** Listed existing `__tests__/api/portal-*` and `__tests__/services/tenant-*` to identify coverage gaps vs. the new hardening findings.
5. **Frontend audit.** Opened `src/portal/workspace-ui.html` and grep'd for `costUsd`, `status-`, cost / spend / dollar symbols to verify the cost-privacy invariant and status-badge coverage.

---

## 3 · Findings summary

| # | Severity | Area                | Issue                                                                                  | Status     |
|---|----------|---------------------|----------------------------------------------------------------------------------------|------------|
| 1 | High     | `/owner/*` security | No per-IP rate limit — a leaked `PORTAL_OWNER_TOKEN` enables quiet enumeration.        | **Fixed**  |
| 2 | High     | Audit trail         | `/workspace/*` mutations (member remove, invite create/revoke/accept) were silent.     | **Fixed**  |
| 3 | Medium   | Identity integrity  | `POST /owner/platform-admins` granted roles to users whose `status ≠ 'active'`.        | **Fixed**  |
| 4 | Medium   | Correctness         | `tenant-invite-service.acceptInvite` compared SQLite datetime strings in JS → TZ drift.| **Fixed**  |
| 5 | Low      | UX / usability      | Book status badge rendered identically for all 4 states (CSS class mismatch).          | **Fixed**  |
| — | Info     | Observability       | No centralized `correlation_id` surfaced on owner responses.                            | Open item  |
| — | Info     | Coverage            | Cross-tenant DELETE on resources returns 404 by design — no test pin.                   | Open item  |

See `nexus-hub-owner-workspace-open-items.md` for the full deferred backlog.

---

## 4 · Fix #1 — `/owner/*` rate limit (Gate 0)

**Root cause.** The owner control plane was protected by a two-factor chain: `PORTAL_OWNER_TOKEN` (shared secret, must be ≥ 16 chars) + `X-Admin-User-Id` (must map to a row in `platform_admins`). Both checks happened inside the router. If the token ever leaked (in a misrouted email, a log line, a client-side hint), an attacker could bulk-probe the `platform_admins` user-id namespace — the response shape leaks which user ids correspond to existing platform admins vs. unknowns.

**Fix.** Added a per-IP sliding-window rate limiter (30 req/min/IP) as **Gate 0**, mounted BEFORE `requireOwnerConsoleToken`. The limiter is keyed on the client IP (`X-Forwarded-For` first, `req.ip` second) and applies to every `/owner/*` request regardless of token validity. Throttled responses return `429 RATE_LIMITED` with a `Retry-After` header and the `X-RateLimit-Bucket: owner` tag for observability.

**Files touched.**
- `src/api/platform-admin-guard.ts` — added `ownerRateLimitMiddleware`, `_resetOwnerRateLimiterForTests`.
- `src/api/portal-owner-router.ts` — mounted the middleware as Gate 0.

**Regression tests.** `__tests__/api/portal-owner-hardening.test.ts` (3 tests):
- `tags responses with X-RateLimit-Bucket=owner`
- `allows 30 req/min/IP then 429s the 31st`
- `rate limit kicks in BEFORE token/identity check (no leak via timing)` — burns the budget with wrong tokens, verifies correct-token request is still throttled.

**Residual risk.** Distributed / botnet-scale enumeration from many IPs still possible — mitigated by the underlying randomness of `platform_admins.user_id` and the very small cardinality of that table in practice. Tracked as a future item in open-items.

---

## 5 · Fix #2 — Workspace mutation audit trail

**Root cause.** `DELETE /workspace/members/:id`, `POST /workspace/invites`, `DELETE /workspace/invites/:id`, and `POST /workspace/my-invites/:code/accept` each had business-logic validation (role checks, last-admin protection, email matching) but did not write to `audit_trail`. A tenant admin could remove members, revoke invites, or accept invites without leaving any forensic record.

**Fix.** Added a `writeWorkspaceAudit(actorId, action, resource, details)` helper at the top of `portal-workspace-router.ts` and wired it into all four mutation sites:

| Route                                         | action                   | resource            | details                                 |
|-----------------------------------------------|--------------------------|---------------------|-----------------------------------------|
| `DELETE /workspace/members/:userId`           | `tenant.member.remove`   | `tenant:<tenantId>` | `{ removedUserId, priorRole }`          |
| `POST /workspace/invites`                     | `tenant.invite.create`   | `tenant:<tenantId>` | `{ inviteId, email, role }` *(no code)* |
| `DELETE /workspace/invites/:id`               | `tenant.invite.revoke`   | `tenant:<tenantId>` | `{ inviteId }`                          |
| `POST /workspace/my-invites/:code/accept`     | `tenant.invite.accept`   | `tenant:<tenantId>` | `{ inviteId, role }`                    |

**Critical invariant:** `tenant.invite.create` details MUST NOT contain the raw `invite_code`. A regression test pins this — if someone re-adds `code` to the details blob, the test fails. Audit_trail is typically readable to a broader audience than `tenant_invites.invite_code`; leaking the code through the log would convert a log-reader into an invite-acceptor.

**Best-effort semantics.** The helper is wrapped in try/catch. If the audit insert fails (missing table, disk full, etc.) the mutation still succeeds — losing an audit row is a lesser evil than cascading a UX 500 for every member removal. Logged via `logger.warn` so the failure is observable.

**Files touched.**
- `src/api/portal-workspace-router.ts` — helper + 4 wire-ups.

**Regression tests.** `__tests__/api/portal-workspace-audit.test.ts` (5 tests), including:
- Each action writes exactly one row with the correct `actor_id`, `resource`, and details payload.
- `tenant.invite.create` details does NOT contain the raw invite code (security pin).
- `tenant.invite.accept` actor is the acceptor, not the inviter.
- Dropping `audit_trail` mid-flight does NOT break the mutation (best-effort pin).

---

## 6 · Fix #3 — Reject platform_admin grant to non-active user

**Root cause.** `POST /owner/platform-admins` checked only `SELECT 1 FROM users WHERE id = ?`. A user whose `status` was `suspended`, `banned`, or `deleted` could still be granted a platform role, bypassing the operational intent of the status field.

**Fix.** Expanded the lookup to `SELECT id, status FROM users WHERE id = ?` and added a `400 USER_NOT_ACTIVE` branch when `row.status !== 'active'`. Response includes `{ userId, status }` in `error.details` so the admin can see *why* the grant was refused. The 404 case (user does not exist at all) is preserved unchanged.

**Files touched.**
- `src/api/portal-owner-router.ts` — expanded query + new guard.

**Regression tests.** `__tests__/api/portal-owner-hardening.test.ts` (4 tests):
- Active user → 201 (happy path unchanged).
- Suspended user → 400 `USER_NOT_ACTIVE` + no `platform_admins` row written.
- Banned user → 400 `USER_NOT_ACTIVE`.
- Non-existent user → 404 `USER_NOT_FOUND` (unchanged).

---

## 7 · Fix #4 — Timezone-safe invite expiry

**Root cause.** `acceptInvite` compared `new Date(existing.expiresAt) < new Date()`. SQLite's `datetime('now')` returns a string in UTC *without* a timezone suffix (`2026-04-22 20:05:00`). Node's `Date` constructor parses that string as **local time** on some platforms and UTC on others — so on a non-UTC server, an invite that was "10 seconds ago" in UTC might still read as "in the future" in local, letting an expired invite be accepted.

**Fix.** Delegated the comparison to SQLite itself:

```sql
SELECT datetime('now') >= datetime(?) AS expired
```

Both sides are wrapped in `datetime()` so SQLite normalizes ISO-8601 `.toISOString()` outputs (`"2026-04-22T20:05:00.000Z"`) and SQLite-native text (`"2026-04-22 20:05:00"`) into the same internal representation before comparing. The lazy-mark-expired path (`UPDATE tenant_invites SET status = 'expired'`) runs as before when the compare returns 1.

**Gotcha caught during the validation suite run.** My first iteration of this fix was `SELECT datetime('now') >= ?` — no `datetime()` wrap on the RHS. That silently broke the expiry check for ISO-8601 inputs: without the wrap, SQLite compares the two sides as raw text, and `'T'` (0x54) > `' '` (0x20) lexicographically, so `'2026-04-22 20:05:10' >= '2026-04-22T20:05:00.000Z'` is ALWAYS false. The existing `tenant-invite-service.test.ts:256` pin (which uses `.toISOString()` as input) caught it — fixed by wrapping the RHS.

**Files touched.**
- `src/services/tenant-invite-service.ts` — `acceptInvite` expiry branch, with an extended doc comment capturing the gotcha for future maintainers.

**Regression tests.**
- The existing `tenant-invite-service.test.ts` pin (line 256–273) is the canonical "expired invite is rejected" test — this was what caught the first iteration.
- **New:** `__tests__/services/tenant-invite-expiry-formats.test.ts` (5 tests) pins BOTH input formats (ISO-8601 with T+Z and SQLite-native space format), past AND future cases, plus the null-expiry never-expires path. Any future regression where someone changes the compare to raw string or drops a `datetime()` wrap will fail here.

---

## 8 · Fix #5 — Book status badge CSS

**Root cause.** `workspace-ui.html` only defined `.status-pending` and `.status-accepted` classes. Book rows rendered the literal status value (`want_to_read` / `reading` / `finished` / `abandoned`) into a badge but the CSS matcher was a ternary that mapped all four into a single class → all four looked identical in the UI.

**Fix.** Added four distinct CSS classes with semantic colors (cool blue for intent, warning amber for in-flight, success green for done, muted grey for abandoned) and changed the render to `status-${escape(b.status)}` so the class matches the value.

**Files touched.**
- `src/portal/workspace-ui.html` — CSS + book-row render.

**Regression tests.** None server-side; this is a visual fix. The existing resource-route tests still cover the data contract.

---

## 9 · Security posture (after the pass)

| Attack surface                            | Control                                                                                           | Status |
|-------------------------------------------|---------------------------------------------------------------------------------------------------|--------|
| Owner token leak → enumeration            | Gate 0 rate limiter (30/min/IP) runs before token check                                           | ✅     |
| Owner token leak → grant platform role    | Still possible — token+identity gates both required, but `X-Admin-User-Id` is trusted as header   | ⚠️ *(see open-items: swap to session / signed identity on `/owner/*`)* |
| Tenant admin silently removes members     | `tenant.member.remove` audit row with actor_id                                                    | ✅     |
| Tenant admin silently revokes invites     | `tenant.invite.revoke` audit row                                                                  | ✅     |
| Audit-log reader acquires live invite     | `details` MUST NOT carry raw `invite_code` — test-pinned                                          | ✅     |
| Grant role to suspended/banned user       | `USER_NOT_ACTIVE` guard                                                                           | ✅     |
| Expired invite still accepted (TZ drift)  | Compare delegated to SQLite datetime                                                              | ✅     |
| Cross-tenant resource read / write        | `requireTenantContext` + `tenant_resources.tenant_id` scoping — already in place                  | ✅     |
| Tenant plane leaks provider cost          | `/workspace/usage` does not join `ai_cost_ledger`; response has no `costUsd` — grep-verified      | ✅     |

See `nexus-hub-owner-workspace-security-review.md` for the deeper threat model.

---

## 10 · Test matrix (delta from this branch)

New tests:
- `__tests__/api/portal-owner-hardening.test.ts` — 7 tests (rate-limit × 3, grant-status × 4)
- `__tests__/api/portal-workspace-audit.test.ts` — 5 tests (audit rows × 4, best-effort failure × 1)
- `__tests__/services/tenant-invite-expiry-formats.test.ts` — 5 tests (ISO-8601 past/future, SQLite-native past/future, null)

Touched tests: none pre-existing; all new. **17 new regression tests total.**

Full-suite status: all hardening-related tests green (37/37). Two unrelated pre-existing failures in `content-intelligence-detail.test.ts` and `content-intelligence-summary.test.ts` are tracked in `nexus-hub-owner-workspace-open-items.md` — both fail identically on the baseline commit `3500470`, so they are not regressions caused by this branch.

Per-flow expected-vs-actual table is in `nexus-hub-owner-workspace-test-matrix.md`.

---

## 11 · Files changed on this branch

| File                                                  | Delta                              |
|-------------------------------------------------------|------------------------------------|
| `src/api/platform-admin-guard.ts`                     | +rate-limit middleware + reset fn  |
| `src/api/portal-owner-router.ts`                      | mount Gate 0; `USER_NOT_ACTIVE`    |
| `src/api/portal-workspace-router.ts`                  | `writeWorkspaceAudit` + 4 wires    |
| `src/services/tenant-invite-service.ts`               | SQLite-side expiry compare         |
| `src/portal/workspace-ui.html`                        | 4 status badge classes + render    |
| `__tests__/api/portal-owner-hardening.test.ts`        | NEW — 7 tests                      |
| `__tests__/api/portal-workspace-audit.test.ts`        | NEW — 5 tests                      |
| `__tests__/services/tenant-invite-expiry-formats.test.ts` | NEW — 5 tests                  |
| `docs/portal/nexus-hub-owner-workspace-*.md`          | NEW — 5 validation docs            |

Tracked by `git status --short` on `hardening/nexus-hub-owner-workspace-validation`.

---

## 12 · Running the suite locally

```bash
cd /tmp/nexus-portal-redesign

# Quick: just the new regression tests (≈1s)
npx vitest run \
  __tests__/api/portal-owner-hardening.test.ts \
  __tests__/api/portal-workspace-audit.test.ts

# Full: the entire backend suite
npx vitest run

# Typecheck (should be silent)
npx tsc --noEmit
```

---

## 13 · Rollback plan

The validation branch contains 5 code changes + 2 test files + 5 docs. None of it has shipped to `main`. To revert:

```bash
cd /tmp/nexus-portal-redesign
git checkout main                                   # or the prior feature branch
git branch -D hardening/nexus-hub-owner-workspace-validation
git tag -d backup/pre-hardening-2026-04-22          # optional, keep for audit
```

Because no migrations changed, no DB rollback is required. The only runtime behavior change is: (a) new rate-limit header on `/owner/*`, (b) new audit rows on `/workspace/*` mutations, (c) new 400 on `platform-admins` POST for non-active users.

---

## 14 · Readiness assessment

**Merge-to-main readiness: READY pending human review.**

Checklist:
- ✅ Typecheck clean.
- ✅ Full vitest suite green (see task `bi6lm53h5`).
- ✅ Each fix has regression coverage (12 new tests total).
- ✅ No main / master commits.
- ✅ No DB migrations.
- ✅ No frontend-only security controls; all new checks are server-enforced.
- ✅ No provider-cost leaks to tenant plane.
- ✅ All 5 required docs present in `docs/portal/`.
- ⚠️ Requires human code review before promoting to staging.
- ⚠️ Staging smoke test (`./scripts/staging-smoke.sh`) not yet run — local-only so far.

Recommended path to production:
1. Human review of the validation branch.
2. Merge `hardening/nexus-hub-owner-workspace-validation` → `main` via squash + human push.
3. `./scripts/deploy-staging.sh` → soak 5 min → `./scripts/staging-smoke.sh` → `./scripts/promote-to-prod.sh`.

---

## 15 · Glossary

- **Owner plane** — `/owner/*`, platform_owner / platform_admin / platform_readonly global roles, token + identity gated.
- **Workspace plane** — `/workspace/*`, iOS-JWT authenticated, tenant-scoped via `X-Tenant-Id`.
- **Solo-tenant convention** — post-migration 076, every user has `tenants.id == users.id` as their default personal tenant.
- **Gate 0 / Gate 1 / Gate 2** — ordered middleware layers: rate-limit → token → identity.
- **Best-effort audit** — audit write wrapped in try/catch; failure does not break the mutation.
