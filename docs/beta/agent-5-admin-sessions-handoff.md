# Agent 5 Handoff — Gap 5 Portal/Admin Operator Sessions

Branch: `beta/gap-5-admin-sessions`
Worktree: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/beta-agents/gap-5-admin-sessions`
Base: `beta/rc` (with Agent 2 tenant-isolation and Agent 7 observability merged)

## Admin Session Model Summary

The portal already shipped a three-tier credential stack (legacy, read/write/admin,
signed `ps_` operator sessions) plus optional actor allowlist and actor HMAC
signature verification. Gap 5 closes the last-mile gaps that were blocking
broader admin exposure:

- **Boot-time admin exposure classification.** A new preflight resolves the
  effective admin exposure mode at startup — one of `disabled`, `loopback_only`,
  `session_only`, `signed_static`, `static_allowlisted`, `static_with_actor`, or
  `static_open`. The first four are beta-safe; the rest log a structured warning
  in production so the operator portal and on-call runbook see it.
- **Beta hardened boot switch.** Setting `PORTAL_BETA_HARDENED=true` refuses
  to start the portal unless the exposure mode is beta-safe. Misconfigurations
  (e.g. `PORTAL_REQUIRE_SESSION_AUTH=true` without `PORTAL_SESSION_SECRET`)
  fail fast with a fatal log instead of silently 401-ing every admin request.
- **Admin-scoped audit for operator alerts.** `POST /api/operator-alerts/:id/ack`,
  `/resolve`, and `/retry-delivery` now require the admin token scope via
  `requirePortalAdminToken` and write `admin_mutation` audit rows with the full
  portal auth context (credential kind, actor hint, signature verification).
  Previously these only needed method-based write scope and kept actor identity
  on the alert row alone.
- **Admin-scoped audit for portal actions.** `POST /api/action/:name` continues
  to log `action=access` for the owner tenant (no impersonation) but now
  threads `buildPortalAdminAuditDetails(req)` into the details JSON so the
  operator's credential kind, actor hint, and signature state are captured.
- **Target-user guard on every `:userId` admin route.** A new
  `requireOperatorTargetUser('userId')` middleware chains after the admin
  token guard on user-routes, user-skill-routes, and admin-data-routes. It
  validates the id format, confirms the target user row exists (404 if not),
  and fails closed with 403 when `PORTAL_OPERATOR_USER_SCOPES` declares a
  per-operator allowlist and the authenticated operator is not scoped to
  the requested user. Preserves god-mode behavior for single-owner deploys
  (when the scope map is empty).

## Admin Exposure Decision Table

| Configuration                                                 | Mode                 | Beta-safe | Boot with `PORTAL_BETA_HARDENED=true`         |
|---------------------------------------------------------------|----------------------|-----------|-----------------------------------------------|
| No tokens, no session secret, no loopback bypass              | `disabled`           | ✅        | ✅                                            |
| Loopback bypass only                                          | `loopback_only`      | ✅        | ✅                                            |
| Session secret + `PORTAL_REQUIRE_SESSION_AUTH=true`           | `session_only`       | ✅        | ✅                                            |
| Admin token + `PORTAL_ADMIN_ACTOR_SIGNATURE_SECRET`           | `signed_static`      | ✅        | ✅                                            |
| Admin token + actor allowlist (`PORTAL_ADMIN_ACTORS`)         | `static_allowlisted` | ❌        | boot refused                                  |
| Admin token + `PORTAL_ADMIN_REQUIRE_ACTOR=true`               | `static_with_actor`  | ❌        | boot refused                                  |
| Admin token alone                                             | `static_open`        | ❌        | boot refused                                  |

## Changed Files

- `.env.example`
- `src/config.ts`
- `src/portal/security.ts`
- `src/portal/server.ts`
- `src/portal/admin-target-user.ts` *(new)*
- `src/portal/action-routes.ts`
- `src/portal/admin-data-routes.ts`
- `src/portal/operations-routes.ts`
- `src/portal/user-routes.ts`
- `src/portal/user-skill-routes.ts`
- `__tests__/portal/portal-admin-beta-readiness.test.ts` *(new)*
- `__tests__/portal/portal-operator-user-scope.test.ts` *(new)*
- `__tests__/portal/portal-admin-data-isolation.integration.test.ts`
- `__tests__/portal/portal-admin-data-routes.test.ts`
- `__tests__/portal/portal-admin-scope.test.ts`
- `__tests__/portal/portal-action-routes.test.ts`
- `__tests__/portal/portal-operations-routes.test.ts`
- `__tests__/portal/portal-user-routes.test.ts`
- `__tests__/portal/portal-user-skill-routes.test.ts`
- `__tests__/api/secret-guards.test.ts`
- `docs/beta/agent-5-admin-sessions-handoff.md` *(new)*

## Tests Added

- **Portal admin exposure classification** (`portal-admin-beta-readiness.test.ts`)
  — seven tests covering each mode resolution, plus preflight behavior:
  - `PORTAL_REQUIRE_SESSION_AUTH=true` without session secret → fatal throw.
  - `PORTAL_BETA_HARDENED=true` with non-safe mode → fatal throw.
  - `PORTAL_BETA_HARDENED=true` with `session_only` / `signed_static` → boot.
  - Production + `static_open` → warn log.
  - Production + `session_only` → info log only.
  - Development + `static_open` → info log only (no warn).
- **Operator target-user guard** (`portal-operator-user-scope.test.ts`)
  — 13 tests covering the pure helper `isOperatorScopedToUser` and the
  `requireOperatorTargetUser` middleware:
  - Invalid id format → 400 `INVALID_USER_ID`.
  - Unknown user → 404 `USER_NOT_FOUND`.
  - No scopes configured → pass-through, target id attached to req.
  - Scopes configured, operator outside list → 403 `FORBIDDEN`.
  - Scopes configured, operator missing actor hint → 403.
  - Scopes configured, operator scoped to target → pass-through.
  - Custom param name (`tenantId`) → correctly resolved.
  - Case-insensitive actor matching.
- **Operator-alert admin audit** (`portal-operations-routes.test.ts`)
  — ack/resolve/retry-delivery assertions that the admin token middleware
  is in the handler chain and `logPortalAdminMutation` is called with the
  correct resource string and alert id. Adds a negative case proving no
  audit row is written when the underlying service returns `false` (404).
- **Portal action operator-attribution** (`portal-action-routes.test.ts`)
  — asserts `buildPortalAdminAuditDetails(req)` is called and its output
  is threaded into the audit trail `details` JSON.
- **Session signature tampering** (`secret-guards.test.ts`) — four new
  negative tests:
  - Flipped signature byte → 401.
  - Forged payload with intact signature → 401.
  - Valid session signed with a different secret (cross-env replay) → 401.
  - Structurally invalid payload (`v=2`, missing actor) with valid HMAC → 401.
- **Portal admin scope string-match regression**
  (`portal-admin-scope.test.ts`) — asserts operator-alert mutations now
  reference `requirePortalAdminToken`, that each `:userId` admin route
  chains `requireOperatorTargetUser('userId')`, and that `server.ts` calls
  `validatePortalAdminBetaReadiness(config.portal)` during boot.
- **Integration seeding fix** (`portal-admin-data-isolation.integration.test.ts`)
  — adds `users` rows for 501/502 so Agent 2's tenant-isolation integration
  suite survives the new 404 target-user check without changing its
  assertions.

## Tests Run

- `npm install` in worktree (populated ignored deps).
- `npx tsc --noEmit` — passed.
- `npx vitest run` (full suite) — **337 test files, 5,373 tests passed, 0 failed**.
- Targeted re-runs during iteration:
  - `__tests__/portal/portal-admin-beta-readiness.test.ts` — 16 passed.
  - `__tests__/portal/portal-operator-user-scope.test.ts` — 13 passed.
  - `__tests__/portal/portal-operations-routes.test.ts` — 12 passed.
  - `__tests__/portal/portal-user-routes.test.ts` — 10 passed.
  - `__tests__/portal/portal-user-skill-routes.test.ts` — 8 passed.
  - `__tests__/portal/portal-admin-data-routes.test.ts` — 6 passed.
  - `__tests__/portal/portal-action-routes.test.ts` — 4 passed.
  - `__tests__/portal/portal-admin-audit.test.ts` — 2 passed.
  - `__tests__/portal/portal-admin-scope.test.ts` — 11 passed.
  - `__tests__/api/secret-guards.test.ts` — 25 passed.
  - `__tests__/services/portal-session-mint.test.ts` — 4 passed.
  - `__tests__/portal/portal-admin-data-isolation.integration.test.ts` — 3 passed.

## Tests That Could Not Run

None. All new tests use in-memory SQLite or pure middleware unit mocks; no
external service was required.

## Is Broad Admin Exposure Safe for Beta?

Yes, **conditional on `PORTAL_BETA_HARDENED=true` being set** during the
beta rollout. Operators opting into broad admin exposure must:

1. Configure `PORTAL_SESSION_SECRET` (32+ random bytes).
2. Set `PORTAL_REQUIRE_SESSION_AUTH=true` **or** configure
   `PORTAL_ADMIN_ACTOR_SIGNATURE_SECRET` (HMAC secret used by the
   trusted session/gateway layer).
3. Set `PORTAL_BETA_HARDENED=true`.

If step 3 is set and steps 1–2 are not met, the portal refuses to start
with a clear fatal log. If `PORTAL_BETA_HARDENED` is **not** set, the
current behavior is preserved: admin mutations succeed with a static
admin token, and a structured `warn` log is emitted in production so
the operator runbook sees the drift.

Unsafe modes (`static_allowlisted`, `static_with_actor`, `static_open`)
remain available for single-owner deployments that predate Gap 5 but are
explicitly excluded by the beta gate.

## Remaining Risks

- `PORTAL_OPERATOR_USER_SCOPES` is the only per-operator access-control
  knob added. Deployments that need finer-grained role separation
  (e.g. "billing ops may change tier but not suspend") still rely on
  shared admin credentials and must implement separate secondary checks
  at the route layer. This was out of scope for beta exposure.
- The operator-alert write routes now require admin scope. If the
  existing on-call runbook or dashboard polled these with a write token,
  those callers must upgrade to the admin token (or a signed session
  with admin scope). Agent 8 should validate the portal HTML still
  uses the admin bearer — which it already does per `portal.html`'s
  login flow.
- The preflight classification does not detect a legacy `PORTAL_TOKEN`
  that is admin-capable via `PORTAL_ALLOW_LEGACY_FALLBACK=true` as a
  distinct mode; such configurations collapse to `static_open`. This is
  intentional — the mitigation is to split into scoped tokens and turn
  off legacy fallback, which was already the Phase-0 hardening guidance.
- `listUsers()` (`GET /api/users`) is protected only by the method-based
  read scope, not by admin scope. That was pre-existing behavior and
  Agent 2's scope already documents token-tier strictness. If exposing
  the user list broadly becomes undesirable, a follow-up can promote
  that route to `requirePortalAdminToken` the same way the operator
  alert mutations were promoted in this pass.

## Notes For Agent 8 — Release / Runbook

- **Single beta flag:** `PORTAL_BETA_HARDENED=true` is the runbook's
  preflight knob. Add it to the staging smoke test after configuring
  `PORTAL_SESSION_SECRET` + `PORTAL_REQUIRE_SESSION_AUTH=true`. If
  `./scripts/deploy-staging.sh` boots cleanly with the flag set, the
  admin exposure mode is verifiably beta-safe.
- **New boot-time log line:** every portal start now emits one of:
  - `info: Portal admin exposure mode` — classification log. Check for
    `adminExposureMode=session_only` or `signed_static` in staging.
  - `warn: Portal admin surface is exposed without signed sessions …`
    — seen only in production for non-beta-safe modes. Include it in
    the on-call alert rules as a release guardrail.
  - `fatal: PORTAL_REQUIRE_SESSION_AUTH=true but PORTAL_SESSION_SECRET is empty`
    / `PORTAL_BETA_HARDENED=true but admin exposure mode is '…'` —
    crash-loop signals for the deploy runbook.
- **Audit trail coverage for operator alerts:** the on-call runbook
  should note that `admin_mutation` audit rows now exist with resource
  values `operator_alert.ack`, `operator_alert.resolve`,
  `operator_alert.retry_delivery`. Use them as the authoritative record
  of who acked/resolved/retried (the alert row still stores the actor
  name for display but audit_trail is the forensic source).
- **Portal action attribution:** the audit rows for `portal.action.*`
  now carry the operator's credential kind and actor hint in
  `details.portalCredential` / `details.portalActorHint`. Dashboards
  that filter by operator can surface these directly.
- **Per-operator scoping:** if the beta onboards multiple operators,
  set `PORTAL_OPERATOR_USER_SCOPES` as a JSON object mapping each actor
  hint to the list of `users.id`s they may admin. Unset keeps god-mode
  behavior for single-owner deploys.

## Notes For Agent 1 Smoke Testing

Beta smoke targets for the admin surface:

- Boot the portal with `PORTAL_BETA_HARDENED=true` **without**
  `PORTAL_SESSION_SECRET` — expect a fatal log and non-zero exit.
- Boot the portal with `PORTAL_BETA_HARDENED=true`,
  `PORTAL_SESSION_SECRET=<random>`, and
  `PORTAL_REQUIRE_SESSION_AUTH=true` — expect `adminExposureMode=session_only`
  info log and a healthy `/health` response.
- Mint a `ps_` operator session via `npm run portal:mint-session --
  --actor operator@example.com --scope admin --ttl-ms 3600000` (the
  script wraps `mintPortalSessionToken`). Hit
  `POST /api/operator-alerts/:id/ack` with the session as a bearer
  — expect 200 and a new `admin_mutation` audit row with
  `resource='operator_alert.ack'`.
- Hit `POST /api/users/99999999/suspend` with an admin token
  — expect 404 `USER_NOT_FOUND` (target-user guard) rather than
  a silent 200.
- Configure `PORTAL_OPERATOR_USER_SCOPES='{"alice@example.com":[1]}'`.
  Mint a session for `alice@example.com`. Attempt `POST /api/users/2/suspend`
  — expect 403 `FORBIDDEN`. Attempt `POST /api/users/1/suspend`
  — expect 200 (or whatever the underlying service returns for the
  valid target).
- Tamper: take a valid session, flip the last character of the signature
  segment, send as `x-portal-session` — expect 401 `Invalid portal token`.
