# Security Foundation Handoff — Gaps 2 and 5

Date: 2026-04-25

Backend branch: `beta/single-agent-rc`  
Backend worktree: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/beta-codex-single-agent`

## Summary

Gap 2 tenant/data isolation was already present in backend `beta/rc` from
`beta/gap-2-tenant-isolation`; this phase revalidated it on the single-agent
branch and preserved the executable proof while adding Gap 5 admin/session
hardening.

Gap 5 reused the narrow, safe commit from `beta/gap-5-admin-sessions`
(`d92ab989aaee7f5812975e851c56c82c1aa3180e`) instead of merging the branch.
The patch adds beta-safe portal exposure classification, signed-session boot
preflight, per-operator target-user scoping, and audit coverage for admin
mutations.

## 2026-04-25 Staging And Production Verification

The local proof below has now been followed by hardened staging and production
checks:

- full backend `npm run verify` passed after the beta hardening work;
- hardened staging operator-session smoke passed valid session, expired
  session, tampered session, unauthorized role/scope, wrong tenant, and
  static-token rejection paths;
- founder accounts `felipedrf74@gmail.com` and
  `vieira.jaqueline@gmail.com` were verified in staging and production with
  founder max access;
- backend production is live at `4.14.66`;
- production app-facing unauthenticated sanity checks returned canonical
  `{ error: { code, message, details? } }` `401` envelopes.

The remaining data-isolation proof is an app-level physical-device
account-switching smoke between the two founder accounts. The backend route,
service, cache, portal, and operator-session proofs are complete.

## Gap 2 Evidence

- Fiscal/vendor APIs have cross-tenant negative tests for listing/deleting
  another user's vendors and for scan-job user scoping.
- Finance APIs prove cross-user transaction and tax-event access is rejected.
- `/api/v1/connections` returns only authenticated-user integration metadata
  and no token material.
- Wearable/health cache keys are tenant-aware through the centralized
  `requireUserCacheKey()` path.
- Integration cache invalidators ignore invalid/synthetic user ids instead of
  clearing shared scopes.
- Account switching is covered by a same-device test proving the previous
  user's refresh token is invalid after the device is re-registered.
- Portal admin data isolation tests now seed target users explicitly so the
  new Gap 5 target-user guard preserves the Gap 2 assertions.

## Gap 5 Changes

- Added `PORTAL_BETA_HARDENED`; when true, portal boot refuses unsafe admin
  exposure modes. Beta-safe modes are `disabled`, `loopback_only`,
  `session_only`, and `signed_static`.
- Added `PORTAL_OPERATOR_USER_SCOPES`, a JSON actor-to-user-id allowlist for
  `:userId` admin routes.
- Added `src/portal/admin-target-user.ts` with fail-closed validation for
  target user id format, target user existence, and operator/user scope.
- Applied the target-user guard to portal admin user/data/skill routes.
- Promoted operator alert ack/resolve/retry-delivery routes to admin scope.
- Added admin mutation audit rows for operator alert actions and threaded
  portal auth context into portal action audits.
- Added beta-readiness logging so unsafe production admin exposure emits a
  structured warning when hardening is not enabled.
- Tightened auth/session regression tests so iOS env flags and mocks are
  restored after each auth revocation test; this prevents full-suite portal
  boot tests from inheriting `IOS_API_ENABLED=true`.

## Tests Added or Reused

- `__tests__/portal/portal-admin-beta-readiness.test.ts`
- `__tests__/portal/portal-operator-user-scope.test.ts`
- `__tests__/portal/portal-admin-scope.test.ts`
- `__tests__/portal/portal-admin-data-isolation.integration.test.ts`
- `__tests__/portal/portal-operations-routes.test.ts`
- `__tests__/portal/portal-action-routes.test.ts`
- `__tests__/api/secret-guards.test.ts`
- `__tests__/api/invoices-tenant-isolation.test.ts`
- `__tests__/api/connections-tenant-isolation.test.ts`
- `__tests__/api/wearable-cache-isolation.test.ts`
- `__tests__/api/auth-routes.test.ts`
- `__tests__/services/invoice-state-isolation.test.ts`
- `__tests__/services/surface-cache-invalidators.test.ts`
- `__tests__/state/user-isolation.test.ts`

## Validation Run

- `npm install` — installed ignored worktree-local dependencies.
- `npm run typecheck` — passed.
- `npx vitest run __tests__/api/secret-guards.test.ts __tests__/services/portal-session-mint.test.ts __tests__/portal/portal-admin-beta-readiness.test.ts __tests__/portal/portal-operator-user-scope.test.ts __tests__/portal/portal-admin-scope.test.ts __tests__/portal/portal-operations-routes.test.ts __tests__/portal/portal-action-routes.test.ts __tests__/portal/portal-admin-data-routes.test.ts __tests__/portal/portal-user-routes.test.ts __tests__/portal/portal-user-skill-routes.test.ts __tests__/portal/portal-admin-data-isolation.integration.test.ts` — 11 files, 112 tests passed.
- `npx vitest run __tests__/api/invoices-tenant-isolation.test.ts __tests__/api/connections-tenant-isolation.test.ts __tests__/api/wearable-cache-isolation.test.ts __tests__/api/finance-routes.test.ts __tests__/api/auth-routes.test.ts __tests__/api/wearable-routes.test.ts __tests__/services/invoice-state-isolation.test.ts __tests__/services/invoice-vendor-cleanup.test.ts __tests__/services/invoice-collector-vendors.test.ts __tests__/services/oauth-store.test.ts __tests__/services/surface-cache-invalidators.test.ts __tests__/state/user-isolation.test.ts` — 12 files, 103 tests passed.
- `npx vitest run __tests__/api/auth-session-revocation.test.ts __tests__/api/auth-middleware-device-revocation.test.ts __tests__/portal/portal-token-strength.test.ts` — 3 files, 14 tests passed.
- `npm run verify` — typecheck passed; 342 test files, 5,434 tests passed.

Observed non-fatal runner warnings: missing `node-cron` sourcemap source and
`--localstorage-file` without a valid path.

## Staging Verification Command Reference

The staging smoke described here passed on 2026-04-25. Keep the command shape
as the reference for future release rehearsals:

```bash
PORTAL_SESSION_SECRET='<32+ byte random secret>'
PORTAL_REQUIRE_SESSION_AUTH=true
PORTAL_BETA_HARDENED=true
PORTAL_OPERATOR_USER_SCOPES='{"operator@example.com":[1]}'
npm run verify
npm run build
PORTAL_SESSION_SECRET="$PORTAL_SESSION_SECRET" \
PORTAL_REQUIRE_SESSION_AUTH=true \
PORTAL_BETA_HARDENED=true \
PORTAL_OPERATOR_USER_SCOPES="$PORTAL_OPERATOR_USER_SCOPES" \
npm start
```

Mint a short-lived operator session only in the secured environment:

```bash
PORTAL_SESSION_SECRET="$PORTAL_SESSION_SECRET" \
npm run portal:session:mint -- --actor operator@example.com --scope admin --ttl-ms 900000
```

Then smoke:

- valid signed admin session succeeds on an allowed `:userId`;
- expired session returns 401;
- tampered session returns 401;
- write/read token without admin scope returns 401 or 403 on admin mutations;
- actor outside `PORTAL_OPERATOR_USER_SCOPES` returns 403 for the target user;
- attempted impersonation without scope leaves an audit trail only for denied
  access logs and does not mutate user data;
- two real/staging users cannot see each other's fiscal, finance, connection,
  wearable/health, plan, skill, or portal admin data.

## Status

- Gap 2: complete for backend code, local executable proof, and staging
  wrong-tenant/operator-scope proof. Physical-device app account switching
  remains as the public-beta gate.
- Gap 5: complete for code, local executable proof, and hardened staging
  signed operator-session smoke. Production signed-session-only env flip is
  optional and should be followed by a small production smoke if enabled.
