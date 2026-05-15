# Agent 2 Handoff — Gap 2 Tenant/Data Isolation

Branch: `beta/gap-2-tenant-isolation`  
Worktree: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/beta-agents/gap-2-tenant-isolation`

## Summary of Isolation Risk Fixed

This pass hardens and proves app-facing tenant isolation for the release-blocker paths called out in Gap 2:

- Fiscal/vendor APIs now have DB-backed negative proof that user B cannot list or delete user A's invoice vendors and that scan jobs receive only the authenticated `userId`.
- Finance APIs now prove user B cannot read, update, or mark paid user A's transactions/tax events.
- Integration metadata now has API proof that `/api/v1/connections` returns only the authenticated user's connection metadata and never token/credential material.
- Wearable/health cache keys now use a centralized `requireUserCacheKey()` helper that rejects invalid tenant scopes and prefixes authenticated user cache keys consistently.
- Integration-derived cache invalidation now ignores invalid/synthetic user ids (`0`, `NaN`) instead of clearing shared/synthetic scopes.
- Account switching now has regression proof that re-registering the same iOS device for user B invalidates user A's stale refresh token.
- Portal admin data routes now have integration proof that read tokens cannot access operator user-data routes and that admin data-summary/audit filtering is scoped to the requested canonical user id.

## Changed Files

- `src/services/cache-store.ts`
- `src/api/routes/wearable.ts`
- `src/services/integration-cache-invalidator.ts`
- `src/api/routes/finance.ts`
- `__tests__/api/invoices-tenant-isolation.test.ts`
- `__tests__/api/connections-tenant-isolation.test.ts`
- `__tests__/api/wearable-cache-isolation.test.ts`
- `__tests__/portal/portal-admin-data-isolation.integration.test.ts`
- `__tests__/api/finance-routes.test.ts`
- `__tests__/api/auth-routes.test.ts`
- `__tests__/api/wearable-routes.test.ts`
- `__tests__/services/surface-cache-invalidators.test.ts`
- `docs/beta/agent-2-tenant-isolation-handoff.md`

## Tests Added

- Cross-tenant finance direct API regression: list/update transaction and mark tax paid.
- Fiscal/vendor direct API regression: list/delete vendor and scan-now user scope.
- Integration metadata regression: OAuth + Garmin connections are per-user and token-safe.
- Wearable/health cache regression: same date across users does not reuse stale cached payloads.
- Central cache helper regression: invalid tenant ids cannot build app-facing cache keys.
- Account switching regression: same device cannot refresh with the previous user's stale refresh token.
- Portal operator regression: read token rejected from admin data routes; admin user filters remain scoped.
- Integration invalidator regression: invalid user ids do not clear synthetic/shared cache scopes.

## Tests Run

- `npm install` to install ignored worktree-local dependencies.
- `npx vitest run __tests__/api/invoices-tenant-isolation.test.ts __tests__/api/connections-tenant-isolation.test.ts __tests__/api/wearable-cache-isolation.test.ts __tests__/portal/portal-admin-data-isolation.integration.test.ts __tests__/api/finance-routes.test.ts __tests__/api/auth-routes.test.ts __tests__/api/wearable-routes.test.ts __tests__/services/surface-cache-invalidators.test.ts`  
  Result: 8 files, 49 tests passed.
- `npm run typecheck`  
  Result: passed.
- `npm test`  
  Result: 335 files, 5,331 tests passed.
- `npm run verify`  
  Result: typecheck passed; 335 files, 5,331 tests passed.

Observed non-fatal test runner warnings: missing `node-cron` sourcemap source and `--localstorage-file` without a valid path.

## Tests That Could Not Run

None. DB/staging credentials were not required; all new isolation tests use in-memory SQLite and mocked external providers.

## Remaining Risks

- Some operator and maintenance paths intentionally operate on global/admin data or owner-bootstrap data. They are not app-facing tenant leaks in this pass, but they still need admin/session policy review before broader multi-operator access.
- Search still shows raw `WHERE id = ?` patterns in state/services for tables that are not always tenant-owned, or are protected by an upstream lookup. Any future exposure of those helpers through app-facing routes should add route/service tests like the ones in this branch.
- Some compatibility invalidators still clear legacy global cache keys (for stale cleanup). The serving paths audited here use tenant keys; if legacy keys become response sources again, add proof tests before release.
- `content-dedup` has a process-local cache keyed by content/context, not tenant. It currently caches dedup results rather than user data. If it starts caching personalized payloads, it needs `requireUserCacheKey()`.
- `invoice-vendor-cleanup` can update vendor rows by id as an operator repair tool. Keep it CLI/operator-only or add admin scoping if it becomes a route.

## APIs/Routes Still Worth Manual Audit

- Portal control-plane route families beyond this pass: `src/portal/user-routes.ts`, `src/portal/user-skill-routes.ts`, `src/portal/action-routes.ts`, `src/portal/admin-audit.ts`.
- Internal/manual report/scheduler bridges using owner bootstrap: `src/api/routes/internal.ts`, `src/services/scheduler.ts`, `src/services/manual-report-triggers.ts`.
- Content/admin operator surfaces with raw id operations: `src/api/routes/content-admin-write.ts`, `src/services/content-workflow.ts`, `src/services/content-learning-store.ts`.

## Notes for Agent 5 Admin/Session Work

- The same-device account-switch test proves `ios_devices.device_id` ownership moves to the newest user and the previous refresh token fails with 401.
- `auth-routes.test.ts` now restores auth-related env vars after each test; this prevents `IOS_API_ENABLED=true` from leaking into portal boot tests.
- Portal admin data route proof currently covers token scope and actor allowlist behavior. Agent 5 should continue auditing signed portal sessions, actor signatures, and all admin routes that accept `:userId`.
- Keep read/write/admin portal token semantics strict: read tokens must not access user-data admin routes.

## Notes for Agent 1 Smoke Testing

Smoke with two real beta users or seeded staging users:

- User A creates a finance transaction/tax event; user B cannot list, patch, delete, or mark it paid through direct `/api/v1/finance/*` calls.
- User A creates an invoice vendor; user B cannot list or delete it through `/api/v1/invoices/vendors`.
- User A and user B connect different providers; `/api/v1/connections` must show only the caller's providers and never token strings.
- Fetch `/api/v1/wearable/summary?date=<same-day>` as user A, then user B, then user A again; returned summaries must stay user-specific.
- Re-register the same device id as user B; user A's old refresh token must return 401 and user B's refresh should return a JWT for user B.
- Portal smoke: `/api/users/:userId/data-summary` with read token returns 401; admin token plus valid actor returns counts for only the requested user.
