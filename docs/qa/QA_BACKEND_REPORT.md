# Backend QA Audit — Beta Readiness

- **Audit date**: 2026-04-27
- **Branch**: `qa/backend-beta-audit`
- **Backend version**: `4.14.97` (`@nexushub/core`)
- **Mode**: Read-only audit (no source modifications)
- **Auditor**: Nexus Hub Backend QA Architect
- **Scope**: backend engines, skill orchestration, Secretary, Training, Finance, Content Creation, Cooking, intelligence bus, API routes, iOS contracts, auth/authorization, tenant isolation, error handling, logging, cache, DB/query behavior, background jobs, tests, doc drift.

---

## Executive Summary

The Nexus Hub backend is in genuinely strong shape. `npm run verify` ships clean: `npx tsc --noEmit` reports zero errors and `npx vitest run` passes 360 / 5,715 tests in ~89 s. That matches CLAUDE.md's documented status and validates the recent coach-engine slice 3.I–3.M provenance work, the entitlement middleware hardening (2026-04-21), the auth-middleware fail-closed device revocation (2026-04-24), and the rate-limiter IP-bucket fallback. The codebase shows a consistent investment in tenant-isolation observability (`tenant-scope-observability`, `recordTenantScopeAnomaly`, `ensureValidTenantRouteScope`) and in deterministic / unit-testable engines (coach-kernel, adaptation-engine, planner-engine).

However the audit surfaced four issue clusters that warrant attention before public TestFlight beta:

1. **Finance encryption is half-implemented.** Plaintext shadow columns persist alongside encrypted columns and SQL aggregates (`getMonthlySummary`) hit the plaintext side. A leaked SQLite backup still exposes income, INSS, IRPF and transaction descriptions in cleartext. The encryption only protects against attackers who can read the encrypted column but not the plaintext sibling — i.e., almost no realistic attacker.
2. **iOS refresh-token at-rest exposure.** `ios_devices.refresh_token` is stored as plaintext with an INDEX on the column (`migrations/038_ios_devices.sql:idx_ios_devices_refresh`). OAuth third-party refresh tokens were carefully encrypted in audit P0-7; the iOS refresh token, which grants the same long-lived blast radius for the *Nexus account itself*, is not encrypted by the same scheme.
3. **Tenant-scope guard is duplicated 7+ times.** `src/api/tenant-route-scope.ts` exists as the canonical helper but most route modules redefine `ensureValidXRouteScope` inline (`chat`, `dashboard`, `notifications`, `reports`, `plan`, `content`, `settings`, …). Top-level `training` and `billing` routes never enforce a route-scope guard at all (per-row enforcement still works for mutations because of `resolveTrainingMutationSession` and Stripe customer linkage, but this is a defense-in-depth regression vs. peers).
4. **Python content-engine usage attribution lands on user_id=0.** `routes/internal.ts:117` calls `recordUsage(0, …)` for every `/api/v1/internal/report-usage` event. AI work generated via the Python content-engine — the most expensive surface in the product — is invisible to the per-user `usage_metering` aggregation that powers `/api/v1/usage` and `/api/v1/billing/usage`. Daily-cap enforcement leans on `acquireCostLock` at the upstream route, which works for `/api/v1/training/plan/generate` and `/api/v1/content/script` but not for any internal proxy path that doesn't lock first.

None of the findings is a hard production stop today, but several should ship as fixes during the iOS-distribution gate window before public TestFlight goes live to the broader beta.

### Score: **78 / 100**

| Bucket | Score | Notes |
| --- | --- | --- |
| Architecture & Engines | 86 | Coach-kernel slices 3.I–3.M raised this from a "probably right" to a "verifiable, deterministic, source-tagged" state. Slice 1 readiness adapter is exemplary. |
| Skill Orchestration | 85 | `skill-manager.ts` cache-invalidation invariants are well tested; entitlement middleware is centralized. |
| API & iOS Contracts | 75 | Standard envelope is clean and consistent through `response-helpers`, but the rate-limiter and tenant-route-scope helpers emit a non-canonical bare-error shape and the duplicated `ensureValid*` helpers risk drifting. |
| Auth & Tenant Isolation | 70 | Strong perimeter (fail-closed JWT, device revocation, IP-bucket rate limit, audit trail) hurt by plaintext refresh-token storage and the uneven scope guard. |
| Cache & DB | 80 | Decrypted-token LRU is correct and cleanly invalidated; SWR pattern is consistent. Two cache-key misalignments (`/training/summary` vs `/home`, several `WHERE id = ?` reads without tenant qualifier) are low-impact. |
| Background Jobs | 80 | Per-user `runWithContext` was correctly applied in the training-plan auto-adjust (2026-04-21 hardening). One stale `require('./push-service')` reference in scheduler is dead. |
| Logging & Observability | 88 | pino + reqId AsyncLocalStorage + `recordOperatorAlert` + Sentry integration is mature. Audit trail honors GDPR carve-outs. |
| Tests | 90 | 5,715 tests is genuinely thorough. Provenance slices are pinned tightly. Gaps are in cross-tenant negative tests on a few new surfaces (see Test Gaps). |
| Documentation | 84 | CLAUDE.md is current and accurate. `IOS-INTEGRATION.md` only covers `/plan/*` despite many other iOS routes shipping. |

---

## Critical Blockers

None. There is no audit finding that requires a production hotfix before continuing the iOS-distribution gates. The two security findings flagged below (finance encryption and iOS refresh tokens) raise the threat model around a leaked SQLite tarball but do not enable a remote attack against a live system.

---

## High-Priority Issues

### H-1 — Finance encryption: shadow columns + plaintext aggregates render at-rest encryption non-functional
- **Severity**: High (security / data-at-rest)
- **Files**:
  - `src/services/finance-tracker.ts` — `addTransaction` (525), `calculateAndStoreTax` (623), `getMonthlySummary` (584).
  - `migrations/` — `finance_transactions` and `finance_tax_events` keep BOTH `amount` and `encrypted_amount` columns simultaneously populated.
- **Why it matters**: CLAUDE.md and the existing service docstring imply finance data is encrypted at rest because the SQLite DB ships in the weekly backup tarball (audit P0-7). In practice, every `INSERT` writes the plaintext to `amount` AND a ciphertext to `encrypted_amount`, then `getMonthlySummary` runs `SELECT category, SUM(amount), COUNT(*) FROM finance_transactions WHERE user_id = ?` — i.e., it must hit the plaintext column because SQL cannot SUM an AES-GCM blob. Same for `calculateAndStoreTax`: `gross_income`, `taxable_income`, `tax_due`, `inss_due` all have `encrypted_*` siblings AND the plaintext column. A leaked backup leaks income, deductions, tax due, transaction descriptions in cleartext. The encryption protects against an attacker who can read `encrypted_amount` but not `amount` — a threat model that does not exist for the SQLite file.
- **Reproduction**:
  1. `sqlite3 data/nexus.db "PRAGMA table_info(finance_transactions);"` and confirm `amount` is plaintext alongside `encrypted_amount`.
  2. `sqlite3 data/nexus.db "SELECT id, amount, encrypted_amount FROM finance_transactions LIMIT 1;"` — `amount` is a numeric value, not encrypted.
- **Suggested test**: `__tests__/services/finance-tracker-at-rest-encryption.test.ts` — after `addTransaction(userId, ..., 1234.56, …)` the on-disk row has `amount IS NULL OR amount = 0` AND `encrypted_amount IS NOT NULL AND length(encrypted_amount) > 60`. Then assert `getMonthlySummary` still returns 1234.56 (i.e., it's reading from the encrypted column via `decryptNumber`).
- **Suggested fix order**:
  1. New migration: `ALTER TABLE finance_transactions DROP COLUMN amount` (or set NULL on all rows, gated behind a `FINANCE_PLAINTEXT_PURGE_ENABLED` flag).
  2. `getMonthlySummary` rewrites: fetch all rows for the month, decrypt `encrypted_amount` per row, aggregate in TS. Worst case is dozens of rows/month/user — trivial cost.
  3. Same for `getAnnualTaxSummary`, `getMonthlyBudgetView`.
  4. Backfill migration: encrypt every plaintext row (already partially handled by the same `tryEncryptNum` path, but no purge step exists).
- **iOS contract impact**: None — the API response shapes don't change.
- **Beta go/no-go**: Ship before the first paid Pro user in production. Founders' beta is fine because the SQLite file is local on the home VPS. As soon as plan-tier upgrades start hitting the real DB with non-founder data, this is a hard ship-blocker.

### H-2 — iOS refresh token stored as plaintext with index
- **Severity**: High (security / credential-at-rest)
- **Files**:
  - `src/services/ios-auth-session.ts:43` — `crypto.randomBytes(64).toString('hex')` then bare INSERT.
  - `migrations/038_ios_devices.sql` — `idx_ios_devices_refresh` is an INDEX on the plaintext column.
  - `src/api/routes/auth.ts:151` — `SELECT user_id, device_id FROM ios_devices WHERE refresh_token = ?` (raw).
- **Why it matters**: Anyone with read access to the SQLite file (backup tarball, ops engineer with SSH, future hosted-DB migration) can read every active iOS refresh token in cleartext. Each refresh token grants 7-day access tokens for the matching `(userId, deviceId)` pair on demand, indefinitely until that row is deleted. This is the same blast radius CLAUDE.md flagged for OAuth refresh tokens in audit P0-7, which were correctly fixed in `oauth-store.ts`. The fix did not extend to the iOS refresh token. The `idx_ios_devices_refresh` INDEX makes the column easy to find in a leaked DB.
- **Reproduction**:
  1. `sqlite3 data/nexus.db "SELECT user_id, refresh_token FROM ios_devices LIMIT 3;"` — refresh_token is hex.
  2. With one of those tokens, POST `/api/v1/auth/refresh` and observe a freshly minted access token.
- **Suggested test**: `__tests__/services/ios-auth-session-encryption.test.ts` — after `createAuthSessionAndRegisterDevice(...)` the `ios_devices.refresh_token` column matches `looksEncrypted(...)`. Then `POST /api/v1/auth/refresh` with the plaintext refresh token returned to the client still works.
- **Suggested fix order**:
  1. Hash the refresh token before storing — store `sha256(token)` in a new `refresh_token_hash` column, drop the INDEX on the plaintext column, look up by hash. Tokens stay random per `crypto.randomBytes(64)` so HMAC isn't strictly needed; SHA-256 collisions are not a threat model concern at 64 bytes of entropy.
  2. Migration: bulk hash existing plaintext tokens, then drop the plaintext column.
  3. Audit trail: keep `logAudit(...action: 'access', resource: 'auth.refresh')` exactly where it is — the refresh path still has the device ID for forensic correlation.
- **iOS contract impact**: None — the client only ever holds and sends the plaintext refresh token; the change is purely on the server side.
- **Beta go/no-go**: Ship before public beta. Same threat model as H-1 — the founders' VPS is private, but the moment beta scales beyond trusted operators this is a real exposure.

### H-3 — Python content-engine usage rolls up under user_id=0
- **Severity**: High (correctness / cost attribution)
- **Files**: `src/api/routes/internal.ts:115–117`, `src/services/usage-metering.ts:recordUsage`.
- **Why it matters**: The Python content-engine is the most expensive AI surface (script generation, deepsearch, hooks). Every call POSTs `/api/v1/internal/report-usage`, which calls `recordUsage(0, inputTokens, outputTokens, cost, false)`. So the usage_metering aggregate row is written for `user_id = 0` (system tenant), not for the actual end user whose session triggered the call. That breaks two contracts:
  - `/api/v1/usage` and `/api/v1/billing/usage` undercount the user's real consumption.
  - The daily cost cap enforced by `cost-guardrail.ts:isUserOverDailyCap(userId)` reads `usage_metering` for the user. A heavy script-generation user could exceed the Pro daily cap by an order of magnitude before the cap kicks in.
  - The route-level `acquireCostLock` IS acquired in `/api/v1/training/plan/generate` and `/api/v1/content/script`, so the racy "blow past the cap by parallelizing 10 calls" case is bounded — but the BURNED cost still attributes to `user_id=0`, not to the user.
- **Reproduction**:
  1. `POST /api/v1/content/script` as a Pro user with a real prompt.
  2. `sqlite3 data/nexus.db "SELECT user_id, sum(cost_usd) FROM api_usage WHERE date >= date('now') GROUP BY user_id"` — the cost lands on user_id=0, not on the caller.
  3. `GET /api/v1/usage` for the same user shows zero cost despite real spend.
- **Suggested test**: `__tests__/api/content-script-usage-attribution.test.ts` — POST the script endpoint, then read `/api/v1/usage` and assert `costUsd` reflects the spend, plus `getDailyUsage(userId)` matches.
- **Suggested fix order**:
  1. Have the Python engine forward `userId` (already passed via the upstream HTTP request — propagate it through `engineFetch` to a `X-Caller-User-Id` header or include it in the report-usage body).
  2. `routes/internal.ts:report-usage` accepts an optional `userId` field, validates it against the existing user table, falls back to 0 only if not supplied.
  3. Recompute one `acquireCostLock` per real user across both TS and Python paths so the cap stays single-source.
- **iOS contract impact**: `/api/v1/usage` becomes accurate (slight UX upgrade — the meter no longer underreports).
- **Beta go/no-go**: Should ship before the public TestFlight cohort, otherwise the daily-cap meter is misleading.

### H-4 — Top-level `training` and `billing` routers never enforce route-scope guard
- **Severity**: High (defense-in-depth, not exploitable today)
- **Files**: `src/api/routes/training.ts`, `src/api/routes/training-plan-routes.ts`, `src/api/routes/billing.ts`.
- **Why it matters**: 17 of 24 top-level iOS routers either use `ensureValidTenantRouteScope` directly or define a local `ensureValidXRouteScope` (chat, dashboard, notifications, plan, content, …). Two important ones do not: `training` (largest single router, including `/training/home`, `/today`, `/week`, `/readiness`, `/coach`, `/complete`, `/skip`, `/coach/apply`, `/plan/generate`, `/plan/sync-calendar`, `/plan/cancel`) and `billing`. Because `authMiddleware` runs first and ALWAYS populates `req.userId` (and fails closed), there is no live exploit. But the codebase has explicitly invested in `recordTenantScopeAnomaly` as a tripwire for "the auth invariant we expected was violated". Removing the tripwire from the largest router defeats the point of the abstraction.
- **Reproduction**: read `src/api/router.ts:208 router.use(authMiddleware); … router.use('/training', trainingRoutes());`, then read `routes/training.ts:138 const { userId } = req as AuthenticatedRequest;` — no `isValidTenantUserId` check, no anomaly hook.
- **Suggested test**: `__tests__/api/training-tenant-isolation.test.ts` — register a tripwire mock for `recordTenantScopeAnomaly`. Bypass `authMiddleware` (test harness mounts the router without it). Assert anomaly fires and a 401 with `{ ok: false, error: { code: 'UNAUTHORIZED' } }` is returned.
- **Suggested fix**: at the top of `trainingRoutes()` and `billingRoutes()`, mount a small guard: `router.use((req, res, next) => ensureValidTenantRouteScope(res, (req as AuthenticatedRequest).userId, '<route>_route', { method: req.method, path: req.path }) ? next() : undefined);`. No new API contract change, no new test fixtures.
- **iOS contract impact**: None — error envelope is already canonical for the rejection path.
- **Beta go/no-go**: Ship in the same patch as H-1/H-2.

---

## Medium-Priority Issues

### M-1 — Rate-limiter and `tenant-route-scope` emit a non-canonical bare-error envelope
- **Severity**: Medium (iOS contract drift)
- **Files**: `src/api/rate-limiter.ts:93`, `:124`, `:198`, `:234`; `src/api/tenant-route-scope.ts:20–27`.
- **Why it matters**: `response-helpers.ts` documents the canonical envelope as `{ ok, error: { code, message }, timestamp }`. Auth-middleware now uses `sendError()` (audited 2026-04-24) so 401 envelopes are canonical. But:
  - `rate-limiter.ts` returns bare `{ error: { code: 'RATE_LIMITED', message, retryAfter } }` — no `ok: false`, no `timestamp`.
  - `tenant-route-scope.ts:ensureValidTenantRouteScope` returns `{ ok: false, error: { code: 'UNAUTHORIZED', message } }` — has `ok` but is missing `timestamp`.
  Swift decoders that expect both `ok` and `timestamp` to be non-null will fail-soft (the iOS code apparently tolerates both today), but the contract documented in `response-helpers.ts` is broken in two places.
- **Reproduction**: send 100 rapid requests with the same JWT to any authenticated route → 429 → response body has neither `ok: false` nor `timestamp`.
- **Suggested test**: `__tests__/api/rate-limit-envelope.test.ts` — assert envelope shape on 429 matches `apiError(...)`.
- **Suggested fix**: route both 429 paths and `ensureValidTenantRouteScope` through `sendError(res, …, 429)` / `sendError(res, …, 401)`.
- **iOS contract impact**: Net positive — Swift can drop any compatibility branches that handle the legacy bare shape.

### M-2 — Tenant-scope helper duplicated across 7+ route files
- **Severity**: Medium (maintainability / drift risk)
- **Files**: `src/api/routes/chat.ts`, `dashboard.ts`, `notifications.ts`, `reports.ts`, `plan.ts`, `content.ts`, `settings.ts` each redefine a near-identical `ensureValidXRouteScope`.
- **Why it matters**: The canonical helper is `src/api/tenant-route-scope.ts:ensureValidTenantRouteScope`. The duplicated copies will drift — for example, the `chat.ts` copy uses `layer: 'delivery'` while the canonical helper also uses `'delivery'`, but if one needs to change to `'chat'` in the future, the others won't follow. Several copies omit the `details` argument that the canonical helper accepts. M-1 will bite during the response-shape unification because each duplicate has its own response body.
- **Reproduction**: `grep -rn "function ensureValid.*RouteScope" src/api/routes/`.
- **Suggested test**: ESLint / vitest custom: `__tests__/api/route-scope-helper-uniqueness.test.ts` — fail if more than one definition of `function ensureValid.*RouteScope` exists in `src/api/routes/`.
- **Suggested fix**: drop every duplicate; have callers `import { ensureValidTenantRouteScope } from '../tenant-route-scope'` and pass the operation label they were already constructing locally.
- **iOS contract impact**: None.

### M-3 — `getArtifactChain` cross-tenant access via `user_id=0`
- **Severity**: Medium (tenant isolation, intent unclear)
- **Files**: `src/api/routes/content-learning-routes.ts:257` — `if (row.user_id !== 0 && row.user_id !== userId)`.
- **Why it matters**: A pipeline row with `user_id = 0` is treated as a global / owner-bootstrap record that ANY authenticated user can read. The downstream `getArtifactChain` returns the linked script, performance, and patterns. If the founder seeds owner-only fixture content with `user_id = 0` for any non-public reason (debug, draft, idea bank), every Pro/Free user can read it. The semantics may be intentional (the test `content-owner-scope.test.ts` exists), but the comment doesn't justify it and the intent is invisible at the call site.
- **Suggested test**: explicit `__tests__/api/content-artifact-chain-owner-scope.test.ts` with a comment: "user_id=0 entries are globally readable on purpose because <reason>".
- **Suggested fix**: either narrow the check to `row.user_id !== userId` (drop the global passthrough) OR document the intent explicitly. Pick one.
- **iOS contract impact**: tightening the check could make some founder-side fixtures stop appearing for non-owner accounts; verify before flipping.

### M-4 — `/api/v1/internal/performance-summary` always reads owner data
- **Severity**: Medium (cross-tenant data leak in Python report path)
- **Files**: `src/api/routes/internal.ts:227–252`.
- **Why it matters**: `performance-summary` returns content performance entries for the owner's tenantId regardless of which user the Python engine is currently generating a report for. If the Python engine generates a report for a Pro user, it gets the OWNER's content stats, which are then mixed into AI prompts → cross-tenant data poisoning into AI output for other users.
- **Reproduction**: trace a `report-performance` Python call from a non-owner user and confirm the data returned is the founder's analytics.
- **Suggested test**: `__tests__/api/internal-performance-summary-tenant-scope.test.ts`.
- **Suggested fix**: `performance-summary` accepts a `userId` query param (validated, gated by the shared secret), defaults to the owner only for explicit owner-scoped Python paths.
- **iOS contract impact**: None directly — but reports surfaced in iOS will be cleaner.

### M-5 — Plan generation: `durationWeeks`, `sessionsPerWeek`, `objective` length not validated
- **Severity**: Medium (DoS / cost amplification)
- **Files**: `src/api/routes/training-plan-routes.ts:45–126`, `src/api/routes/training-plan-generation.ts`.
- **Why it matters**: A user can POST `{ objective: "<10MB string>", durationWeeks: 5200, sessionsPerWeek: 14, strengthSessionsPerWeek: 14 }`. The cost lock + quota check protects total spend, but pre-cost work (profile reads, DB inserts, calendar event creation) is unbounded. A hostile beta user can multiply cost on the calendar provider and DB write side. `objective` flows into AI prompts — large objectives push the prompt past `maxTokens` and burn output prematurely.
- **Suggested test**: `__tests__/api/training-plan-input-validation.test.ts` covering each field bound.
- **Suggested fix**: add Zod-style guards (or hand-rolled): `objective.length <= 280`, `1 <= durationWeeks <= 16`, `1 <= sessionsPerWeek <= 14`, `0 <= strengthSessionsPerWeek <= 7`, `preferredTime` matches `/^\d{2}:\d{2}$/`.
- **iOS contract impact**: clients already pass small values; tighter server-side rejection is a net safety win.

### M-6 — Two cache key inconsistencies on training screens
- **Severity**: Medium (potential UX inconsistency)
- **Files**: `src/api/routes/training.ts:140` (`training-home:${userId}:${language}`) vs `:171` (`training-summary:${userId}` — language-less).
- **Why it matters**: If a user changes language between two screens, the training-summary cache returns the old-language session titles for 5 minutes. Inconsistent with `training-home` which keys on language correctly.
- **Suggested fix**: include language in `training-summary` cache key OR remove summary cache (it's already covered by `getCached` for `today`/`week`/`readiness` separately).

### M-7 — Stale `require('./push-service')` in scheduler
- **Severity**: Medium (silent failure of plan-renewal APNs notification)
- **Files**: `src/services/scheduler.ts:1258` — `const { sendPushToUser } = require('./push-service');` — but `src/services/push-service.ts` does NOT exist. The actual APNs sender is `src/services/apns-sender.ts`.
- **Why it matters**: `require()` throws synchronously; the surrounding `try/catch` swallows the throw and logs `'Failed to send plan renewal notification'`. The Telegram message goes through, but the iOS APNs notification on plan-renewal never fires — silently, every Sunday 19:00.
- **Reproduction**: `grep -rn "push-service" src/` → only one match, the broken require.
- **Suggested test**: `__tests__/services/scheduler-plan-renewal-apns.test.ts`.
- **Suggested fix**: replace with `const { sendPushNotification } = require('./apns-sender');` or, better, the existing static import at the top of the file (`apns-sender` is already imported on line 24).
- **iOS contract impact**: APNs notification on plan completion will start firing again.

### M-8 — `secret-guards.ts` portal endpoints emit `{ ok: false }` directly via `res.status(...).json(...)` instead of the canonical helper
- **Severity**: Medium (maintainability, less drift-prone if centralized)
- **Files**: `src/api/secret-guards.ts:354`, `:385`, `:402`, `:420`, `:441`.
- **Why it matters**: same pattern as M-1 but for the portal authentication path. The shape happens to match `apiError(...)` minus `timestamp`. A single timestamp mismatch slipped through here.
- **Suggested fix**: route through `sendError(res, 'UNAUTHORIZED', message, 401)`.

---

## Low-Priority Issues

### L-1 — `scoreToReadinessLevel` doc says "caps the level at orange regardless of score" but score < 40 still returns red
- **File**: `src/services/coach-kernel/readiness-snapshot-adapter.ts:69–82`.
- **Why it matters**: Doc comment says high-severity injury "caps the level at orange regardless of score". Implementation says: cap fires only if score > 65 (so a score of 30 with a high-severity injury still returns `'red'`). This is arguably correct ("cap the upper bound") but the comment is misleading. Low — the test pinning is sufficient that no behavior is at risk.
- **Suggested fix**: rewrite the comment to "high-severity injury caps the level at `'orange'` IF the score would otherwise be `'green'` or `'yellow'`. Truly red days remain `'red'`."

### L-2 — `apns-sender.ts` is imported as a top-level static import but the runtime call inside scheduler.ts uses the wrong service name (M-7)
- See M-7. Low standalone — the bug is the same, just calling out the discoverability angle.

### L-3 — `package.json:lint` is an alias for `typecheck`; there is no real linter (eslint, biome) wired up
- **Files**: `package.json:scripts.lint`.
- **Why it matters**: Coding-standard violations and dead-code warnings are not detected. `npm run lint` succeeds even when actual linting issues exist. CLAUDE.md does not promise eslint, but `lint` as an alias is misleading.
- **Suggested fix**: drop the alias OR add a real linter. Beta-non-blocking.

### L-4 — `console.log` in `src/trigger-reports.ts`
- **File**: `src/trigger-reports.ts` (manual-trigger CLI helper).
- **Why it matters**: This is a manual-trigger CLI script, so console.log is acceptable, but it bypasses the pino reqId trail. Low — this isn't on the request path.

### L-5 — Hard-coded bundle ID `me.nexushub.app` in `src/api/router.ts:185`
- **Files**: `src/api/router.ts:185`.
- **Why it matters**: Apple notification bundle ID is hard-coded at the router level. If a build variant ever uses a different bundle ID (e.g., `me.nexushub.app.beta` for TestFlight builds with sandbox StoreKit), the check rejects all notifications for that variant. There's no test enforcing parity with `config.apple.bundleId`.
- **Suggested fix**: read from `config.apple.bundleId` (or equivalent) and assert the env var is set at boot.

### L-6 — `looksEncrypted` heuristic accepts any 56+ char hex string
- **Files**: `src/services/oauth-store.ts:185–189`.
- **Why it matters**: The legacy-plaintext detection assumes real OAuth tokens contain `/`, `_`, `.`, or `-`. Most do, but a future provider whose tokens are pure hex would be misclassified as already-encrypted. Today's allowed providers (google, outlook, strava, whoop, fitbit, todoist, notion) are all safe; flag for the next provider integration.

### L-7 — Reminder cron runs every minute (`* * * * *`) regardless of whether anyone has reminders
- **Files**: `src/services/scheduler.ts:682`.
- **Why it matters**: Tiny CPU cost, but `getDueReminders()` runs an indexed SELECT 1,440 times/day even on accounts with no reminders. Today's load is fine; flag for scale.

### L-8 — `IOS-INTEGRATION.md` only documents `/plan/*` routes
- **Files**: `docs/IOS-INTEGRATION.md`.
- **Why it matters**: The doc title is "iOS Integration — Multi-Skill Plan API" and it covers exactly four routes. Meanwhile the iOS API surface is ~85 endpoints (see `src/api/routes/`). There is no canonical iOS contract reference document. iOS engineers must read the route source to know the request/response shape. Drift risk is real if iOS adds a screen that needs a new route.
- **Suggested fix**: regenerate an iOS contract reference from the routes file (or at least an INDEX file pointing to where each contract lives). Low because the iOS team has navigated this fine, but worth flagging if the team grows beyond Felipe.

---

## Security Risks (Cross-Cut)

| ID | Risk | Severity | Status |
| --- | --- | --- | --- |
| S-1 | Finance encryption is shadow-column only | High | See H-1 |
| S-2 | iOS refresh tokens at rest are plaintext + indexed | High | See H-2 |
| S-3 | `INTERNAL_API_SECRET` validated with `crypto.timingSafeEqual` ✓ | OK | `secureSecretMatches()` |
| S-4 | Apple webhook bundle-id check uses naive `!==` (after the JWS lib parses) | Medium | OK because we ALSO assert presence and structure, but a real JWS signature verification is still flagged as a known gap (router.ts:155). |
| S-5 | Stripe webhook signature check via `req.headers['stripe-signature']` ✓ | OK | `webhooks.ts` |
| S-6 | Rate limit floor on `/auth/register` and `/auth/refresh` ✓ | OK | Hardening 2026-04-20 |
| S-7 | `authMiddleware` fails CLOSED on DB errors ✓ | OK | Hardening 2026-04-20 |
| S-8 | Device-revocation enforced inside JWT middleware ✓ | OK | Hardening 2026-04-24 |
| S-9 | Owner-only `user_id=0` cross-tenant read in `getArtifactChain` | Medium | See M-3 |
| S-10 | `/api/v1/internal/performance-summary` returns owner data only | Medium | See M-4 |

---

## Tenant Isolation Risks

| ID | Risk | Severity | Status |
| --- | --- | --- | --- |
| T-1 | `training` and `billing` routers omit route-scope guard | High | See H-4 |
| T-2 | Helper duplicated across 7+ files (drift potential) | Medium | See M-2 |
| T-3 | Python engine reports usage as `user_id=0` | High | See H-3 |
| T-4 | Cron `training_plan_adjust` correctly wraps each user in `runWithContext` | OK | 2026-04-21 hardening |
| T-5 | `intelligence-bus.writeSignal` enforces user-scope for non-global signal types ✓ | OK | `signalRequiresUserScope` + `recordTenantScopeAnomaly` |
| T-6 | `oauth-store.getTokens` LRU keyed by `(userId, provider)` and invalidated on store/disconnect/refresh ✓ | OK | Phase 0.C |
| T-7 | All finance-tracker mutations and reads include `user_id = ?` | OK | Verified inline |
| T-8 | Cooking, Tasks, Training mutations all include `WHERE … AND user_id = ?` | OK | Verified for delete/update paths |

---

## Performance Risks

- **P-1**: `/training/summary` and `/training/home` cache for 5 minutes but `/training/today`, `/week`, `/readiness` are not cached at all. iOS clients that prefetch all five hit DB+wearable five times per cold launch. Not a blocker — `getTodaySession` is cheap — but worth measuring.
- **P-2**: `agent_signals` table has TTL-based expiry but `expireStaleSignals()` runs hourly. Active signal counts stay bounded, but heavy multi-user content load could see ~5-10k active signals before cleanup. Add an index on `(status, expires_at)` if not already present.
- **P-3**: Rate-limiter is in-process. Under PM2 cluster mode (not used today) attackers get N× quota. Already documented in source comments. Phase out if/when scaling horizontally.
- **P-4**: `getMonthlySummary` (and similar finance aggregates) decrypt-and-aggregate in TS once H-1 is fixed → loop overhead is bounded by # rows/month, OK.
- **P-5**: `engineFetch` uses 30s default timeout; deepsearch + script generation have explicit longer timeouts (`resolveInternalAiTimeoutMs` returns 90–180 s for `content_engine_*`). Good.

---

## Logic Gaps

- **LG-1**: `adapt-engine.adaptSessionForReadiness` switches on `readiness.level` but `readiness-snapshot-adapter.scoreToReadinessLevel` returns `'red'` even when `hasHighSeverityInjury === true` if the score is < 40. So an injured user with low readiness gets the "red intensity downshift to 60%" branch — NOT the "injury_safe_swap" branch. The injury swap fires only via `injuryAffectsSession === true` passed in from a higher layer. Verify the call site (`AdaptationContext` consumers) actually computes `injuryAffectsSession` correctly per session — not just per athlete.
- **LG-2**: `cooking-chef.parseRecipe` reads `rowid = last_insert_rowid()` after insert. Safe in better-sqlite3 single-process model, but if a future migration moves to a connection pool this becomes a race.
- **LG-3**: `intelligence-bus.expireStaleSignals` runs once per hour; the `signal_immovability` and other Stage 2 mesh signals have 48h TTLs but the `agent_signals.expires_at < datetime('now')` check is timezone-aware (UTC) while signal expiry payloads are computed against `Date.now()` in JS (also UTC). OK.

---

## Test Gaps

- Cross-tenant negative tests for `/training/*`, `/billing/*`. (See H-4 / M-2.)
- `iOS auth refresh token at rest` (H-2).
- `Finance encryption: plaintext column should be NULL post-migration` (H-1).
- `Internal report-usage attributes to caller userId, not 0` (H-3).
- `getArtifactChain rejects user_id=0 for non-owner callers` OR documents intent explicitly (M-3).
- `Plan generation rejects oversized objective and out-of-range durationWeeks` (M-5).
- `Rate-limit and tenant-route-scope envelopes match canonical apiError shape` (M-1, M-8).
- `Scheduler plan-renewal APNs notification fires on plan completion` (M-7).
- `Performance-summary internal route honors caller userId` (M-4).
- `training-summary cache key includes language` (M-6).

---

## Documentation Gaps / Drift

- `IOS-INTEGRATION.md` only describes the multi-skill mesh `/plan/*` routes — see L-8.
- `CLAUDE.md` Hardening Audit section lists "`oauth-store` encrypted, audit P0-7"; the iOS refresh-token in `ios_devices` was not part of P0-7 and is still plaintext (H-2).
- `MODEL-REVIEW-PROCESS.md` and `OBSERVABILITY-ONCALL.md` are present but the Sentry / operator-alert dedupe-keys list is not enumerated; ops engineers can't grep for the deduplication contract by alert.
- `DOCUMENTATION-MAP.md` exists but is not linked from `README` or `DEVELOPMENT.md`. Discoverability is on Felipe's tribal knowledge.
- The `tenant-route-scope.ts` helper is documented to be the canonical one, but 7+ route modules duplicate the helper — see M-2.

---

## Recommended Fix Order

| # | Item | Severity | Why first |
| --- | --- | --- | --- |
| 1 | H-2 iOS refresh-token encryption / hashing | High | Smallest blast-radius reduction with the smallest patch. ~80 LOC + migration. |
| 2 | H-3 Python engine usage attribution | High | One-shot fix to `internal.ts` + Python client. Restores cap correctness. |
| 3 | H-1 Finance encryption purge of plaintext shadow columns | High | Migration + per-row decrypt in TS. Bigger surface, test more carefully. |
| 4 | H-4 Add `ensureValidTenantRouteScope` to `training` and `billing` routers | High | One-line per router. |
| 5 | M-1 + M-8 Standardize 401/429 envelopes through `sendError` | Medium | Trivial routing-layer cleanup. |
| 6 | M-2 Centralize `ensureValid*RouteScope` into `tenant-route-scope.ts` | Medium | After M-1 lands, drop the duplicates. |
| 7 | M-7 Repair scheduler `push-service` require | Medium | One-line. Restores plan-renewal APNs. |
| 8 | M-3 Document or narrow `user_id=0` semantics in `getArtifactChain` | Medium | Decide intent first. |
| 9 | M-4 Per-user `performance-summary` | Medium | Requires Python client signature change too. |
| 10 | M-5 Validate plan-generation inputs | Medium | Adds Zod-light guards. |
| 11 | M-6 Add language to training-summary cache key | Medium | Trivial. |
| 12 | L-1 Fix readiness-adapter doc comment | Low | Comment-only change. |
| 13 | L-3 Wire a real linter or drop the `lint` alias | Low | Optional. |
| 14 | L-5 Read Apple bundle ID from config | Low | Gated by next config audit. |
| 15 | L-8 Generate full iOS contract reference | Low | Quality-of-life. |

---

## Suggested Tests (consolidated)

1. `__tests__/services/finance-tracker-at-rest-encryption.test.ts` — H-1.
2. `__tests__/services/ios-auth-session-encryption.test.ts` — H-2.
3. `__tests__/api/content-script-usage-attribution.test.ts` — H-3.
4. `__tests__/api/training-tenant-isolation.test.ts` — H-4.
5. `__tests__/api/billing-tenant-isolation.test.ts` — H-4.
6. `__tests__/api/rate-limit-envelope.test.ts` — M-1.
7. `__tests__/api/route-scope-helper-uniqueness.test.ts` — M-2.
8. `__tests__/api/content-artifact-chain-owner-scope.test.ts` — M-3.
9. `__tests__/api/internal-performance-summary-tenant-scope.test.ts` — M-4.
10. `__tests__/api/training-plan-input-validation.test.ts` — M-5.
11. `__tests__/api/training-summary-cache-language.test.ts` — M-6.
12. `__tests__/services/scheduler-plan-renewal-apns.test.ts` — M-7.
13. `__tests__/api/secret-guards-error-envelope.test.ts` — M-8.

---

## iOS Contract Implications

| Change | Contract impact |
| --- | --- |
| H-1 finance encryption purge | None on the API surface. Internal aggregations rewrite. |
| H-2 iOS refresh-token hashing | None — client always sends + holds the plaintext token. Server hashes before storage. |
| H-3 Python engine usage attribution | iOS `/usage` and `/billing/usage` will START reflecting Python engine spend. Net positive UX — meter no longer underreports. |
| H-4 add tenant-scope guard | None on the happy path. Anomaly path returns canonical envelope. |
| M-1 / M-8 envelope cleanup | iOS may drop the legacy bare-shape compatibility branch in its `ApiError` decoder. |
| M-3 narrowing `user_id=0` access | If iOS shows "founder fixture" content to non-founders today, that content disappears. Verify before flipping. |
| M-4 per-user performance-summary | Reports rendered in iOS use the right user's performance — net positive. |
| M-5 input validation | iOS already passes safe values today; tighter rejection is invisible. |
| M-6 cache language key | Slight UX win on language switching. |
| M-7 scheduler push fix | iOS APNs notification on plan-renewal starts firing. |

---

## Beta Go / No-Go Recommendation

**Conditional GO**. Beta hardening (single-tenant founders cohort, current TestFlight gate) can proceed. The findings do not block iOS distribution gates that are already documented as the active path: signed TestFlight, APNs token + delivery, fresh auth/onboarding, two-account switching, real provider state, device proof. None of those gates is moved by this audit.

For the wider PUBLIC TestFlight beta — the moment non-founder users hold real refresh tokens and real finance data on the live SQLite — the audit recommends shipping H-2, H-3, and H-4 first, in that order, in a single hardening patch. They are small, well-scoped, and each has an obvious fix. H-1 (finance encryption purge) needs more migration care and should land in a follow-up patch within the same beta cycle, not blocking the cohort expansion.

The Medium and Low items are normal beta-cycle hygiene and can be scheduled into the next 1–2 release patches without holding the gate.

---

## Verification of Audit

- Static analysis: `npx tsc --noEmit` clean.
- Test suite: `npx vitest run` — 360 / 5,715 tests green in 88.63 s.
- Tenant-scope helper inventory: 17/24 top-level routers enforce; 7/24 don't (training, billing, dashboard*, chat*, notifications*, reports*, content* — the asterisks have local copies of the helper, only training and billing have NO guard at all).
- Migration inventory: 85 files in `migrations/`, latest is `080_training_session_preferred_time_unavailable.sql`.
- Background job inventory: 32 cron jobs registered in `scheduler.ts`. All wrapped with `wrapJob`. Per-user `runWithContext` confirmed for `training_plan_adjust` (per audit hardening).
- Coach kernel: 5 sport engines + adaptation engine + planner + guardrails + readiness adapter. All pure (no I/O), all unit tested. Slices 3.I–3.M provenance functions verified.

---

*End of report.*
