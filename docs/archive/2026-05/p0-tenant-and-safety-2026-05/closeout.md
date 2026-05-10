# P0 Tenant And Safety — Round A Closeout

Date: 2026-05-10
Status: SOURCE_AND_LOCAL_VALIDATION_COMPLETE

## Scope

Round A intentionally split the launch-readiness prompt at Parts 1 and 2:
multi-tenant sibling leaks plus production safety/data-exfiltration controls.
Parts 3-5 (Felipe-volume performance, second-pass performance, accessibility)
remain queued for a separate `fix/perf-and-a11y-2026-05` round after hostile QA.

Branches:
- Engine: `fix/p0-tenant-and-safety-2026-05`
- iOS: `fix/p0-tenant-and-safety-2026-05`

Backup tags:
- `backup/p0-tenant-and-safety-engine-before-20260510-1422`
- `backup/p0-tenant-and-safety-ios-before-20260510-1422`

Cleanup contract:
- Production was not touched.
- Engine `main` was not pushed.
- iOS `main` was not pushed.
- No TestFlight build was cut.

## Diagnosis

The source-side sweep confirmed the launch-blocking findings were real:

- Google Drive still had a global OAuth surface in `src/services/google-drive.ts`; Drive callers did not carry authenticated user identity through every upload path.
- iOS auth state was applied in sequential writes, so repository loads could observe stale scope during sign-in.
- `DeepLinkRouter` stored pending destinations globally without user-scope stamping.
- Auth tokens were stored under generic keychain keys, allowing cross-user token replacement on shared devices.
- APNs sign-out only cleared local token state and did not revoke the backend device-to-user binding.
- Chat fastpath pending-task cache keys were user-scoped but not tenant-scoped.
- WebSocket connections stored `tenantId = userId` and did not revalidate tenant scope per message.
- Onboarding progress in `UserDefaults` survived sign-out.
- Sentry sanitization removed only `user.ip_address`; headers, request bodies, contexts, and `extra` payloads could leak PII/tokens.
- `api_cache` had TTL cleanup but no safety valve/index for stalled cleanup growth.
- Closed-beta invite handling existed in iOS error translation, but the backend registration paths did not enforce a consistent server-side invite gate. This was escalated during the round and fixed before continuing.

## Implementation Evidence

### Fix 1.1 — Google Drive Per-User OAuth

Engine now builds Drive clients via `buildGoogleOAuth2ClientForUser(userId)` and keeps Drive/folder caches user-keyed. Public Drive upload/backup helpers require user identity, while system backup paths explicitly resolve the owner bootstrap user.

Key files:
- `src/services/google-drive.ts`
- `src/services/content-file-saver.ts`
- `src/handlers/commands/content.ts`
- `src/handlers/media.ts`
- `src/services/video-study.ts`
- `src/services/backup.ts`
- `scripts/cleanup-tainted-google-drive-sessions.mjs`
- `__tests__/security/google-drive-tenant-leak.test.ts`

Evidence: focused security suite PASS; non-owner without Google OAuth does not fall back to owner credentials, and owner/system no-user backup flow remains explicit.

### Fix 1.2 — iOS Sign-In Race Scope Barrier

`AuthManager` now applies token/user auth state atomically via one session application path and exposes `signInComplete` as a load barrier. `CachedResource.load()` waits on that barrier before fetching, so first repository loads after sign-in cannot run under stale scope. `Nexus_HubApp` now awaits scope reconciliation before enqueueing repository work.

Key files:
- `Nexus Hub/Core/AuthManager.swift`
- `Nexus Hub/Core/Repositories/CachedResource.swift`
- `Nexus Hub/Core/AppState.swift`
- `Nexus Hub/Nexus_HubApp.swift`
- `Nexus HubTests/AuthScopeRaceTests.swift`

Evidence: Debug focused iOS unit suite PASS, including the synthetic mid-sign-in repository load.

### Fix 1.3 — iOS Deep-Link Scope Awareness

Pending deep links now store the current user scope at enqueue time. `MainTabView` drops queued routes whose scope does not match the signed-in user, and sign-out clears pending route state.

Key files:
- `Nexus Hub/Core/DeepLinkRouter.swift`
- `Nexus Hub/Views/MainTabView.swift`
- `Nexus HubTests/DeepLinkRouterTests.swift`
- `Nexus HubUITests/DeepLinkScopeUITests.swift`

Evidence: Debug unit + source-pinned UI regression PASS.

### Fix 1.4 — iOS User-Scoped Keychain Tokens

Access/refresh tokens are now saved under `nexus_access_token.user-<userId>` and `nexus_refresh_token.user-<userId>`. First-launch migration reads legacy keys, writes scoped keys when a user is known, then removes the old generic key.

Key files:
- `Nexus Hub/Core/AuthManager.swift`
- `Nexus HubTests/KeychainHelperTests.swift`

Evidence: `KeychainHelperTests` proves two users' scoped token keys can coexist.

### Fix 1.5 — APNs Binding Revocation On Sign-Out

Engine now exposes an idempotent `DELETE /api/v1/settings/push-token` route. iOS calls it before clearing the in-memory registration token during sign-out.

Key files:
- `src/api/routes/settings.ts`
- `__tests__/api/settings-routes.test.ts`
- `Nexus Hub/Core/Services/SettingsService.swift`
- `Nexus Hub/Core/NotificationManager.swift`
- `Nexus Hub/Core/AppState.swift`
- `Nexus HubTests/NotificationManagerTests.swift`

Evidence: engine route regression PASS; iOS sign-out revoke path regression PASS.

### Fix 1.6 — Chat Fastpath Tenant Cache Key

Pending-task cache keys now include both user and tenant:
`u:<userId>:t:<tenantId>:fastpath:pending-tasks`. All pending-task cached callers thread tenant context through the fastpath.

Key files:
- `src/api/routes/chat-fastpath.ts`
- `src/utils/request-context.ts`
- `__tests__/security/chat-fastpath-tenant-leak.test.ts`

Evidence: security regression proves same numeric user id across different tenants produces distinct cache keys.

### Fix 1.7 — WebSocket Tenant Claim And Revalidation

iOS JWTs now carry an optional `tenantId` claim. Auth middleware and WebSocket auth validate the claim against canonical scope, fall back to canonical lookup for rotated tokens, and revalidate tenant scope on every WebSocket message.

Key files:
- `src/services/ios-jwt.ts`
- `src/services/ios-auth-session.ts`
- `src/api/auth-middleware.ts`
- `src/api/websocket.ts`
- `__tests__/security/websocket-tenant-switch.test.ts`

Evidence: JWT signing/verification source test PASS; WebSocket source pin confirms per-message tenant revalidation wiring.

### Fix 1.8 — Onboarding UserDefaults Scope Cleanup

`nexus_onboarding_current_step` is now removed during sign-out.

Key files:
- `Nexus Hub/Core/AppState.swift`
- `Nexus HubTests/OnboardingScopeIsolationTests.swift`

Evidence: focused iOS test PASS.

### Fix 2.1 — Sentry PII Redaction

Sentry `beforeSend`, `captureException`, and `captureMessage` now sanitize request headers, request data, contexts, and extras using the existing log-sanitizer path.

Key files:
- `src/services/error-tracker.ts`
- `__tests__/services/error-tracker.test.ts`

Evidence: unit tests prove fake auth headers, request bodies, contexts, and extra payloads are redacted before Sentry emission.

### Fix 2.2 — `api_cache` Growth Safety Valve

Expired cache cleanup now deletes in bounded 10k chunks ordered by expiry/key and emits an `error_log` warning if the safety valve fires. A compound index supports the cleanup path.

Key files:
- `src/services/cache-store.ts`
- `migrations/117_api_cache_expires_key_index.sql`
- `__tests__/services/cache-store-observability.test.ts`

Evidence: observability regression inserts 50k expired rows, runs cleanup, verifies the table drops below 10k and warning telemetry fires.

### Fix 2.3 — Closed-Beta Invite Gate

Server-side registration paths now enforce invites consistently across email/password, native Apple, Apple web session, native Google, and Google web session flows. Missing invites return `INVITE_REQUIRED`; invalid invites return `INVALID_INVITE`; valid allowlisted invites can create accounts.

Key files:
- `src/services/user-service.ts`
- `src/api/routes/auth.ts`
- `src/services/google-sign-in.ts`
- `src/services/apple-web-sign-in.ts`
- `src/services/google-auth-session-store.ts`
- `src/portal/oauth-routes.ts`
- `__tests__/api/auth-routes.test.ts`

Evidence: auth route regressions prove missing/invalid invite failures and valid invite success. Server-enforced verdict: YES.

## Behavioral Evidence

Engine local gates:
- Typecheck PASS: `npx tsc --noEmit --pretty false`.
- Focused P0 tenant/safety suite PASS: 10 files / 119 tests.
- Cannot-skip dashboard PASS: 34/34, with new `google-drive-tenant-leak` gate.
- Mock completeness lint PASS at strict baseline: 827 partial mocks.

iOS local gates:
- Debug build PASS.
- Debug focused unit suite PASS: 53 tests / 0 failures.
- Deep-link scope UI regression PASS: 1 test / 0 failures.
- ReleaseWithTesting full unit suite PASS: 1,255 XCTest + 10 Swift Testing / 0 failures.
- ReleaseWithTesting visual matrix PASS: 21/21 tests with 80 PNG screenshots.

iOS evidence paths:
- Debug focused unit xcresult: `/Users/felipedominguez/Library/Developer/Xcode/DerivedData/Nexus_Hub-feiemmrqhyplkkdyihrzwkqpdbqn/Logs/Test/Test-Nexus Hub-2026.05.10_15-22-40-+0100.xcresult`
- Deep-link UI xcresult: `/Users/felipedominguez/Library/Developer/Xcode/DerivedData/Nexus_Hub-feiemmrqhyplkkdyihrzwkqpdbqn/Logs/Test/Test-Nexus Hub-2026.05.10_15-23-08-+0100.xcresult`
- ReleaseWithTesting full unit xcresult: `/Users/felipedominguez/Library/Developer/Xcode/DerivedData/Nexus_Hub-feiemmrqhyplkkdyihrzwkqpdbqn/Logs/Test/Test-Nexus Hub-2026.05.10_15-32-02-+0100.xcresult`
- ReleaseWithTesting visual matrix xcresult: `/Users/felipedominguez/Library/Developer/Xcode/DerivedData/Nexus_Hub-feiemmrqhyplkkdyihrzwkqpdbqn/Logs/Test/Test-Nexus Hub-2026.05.10_15-33-44-+0100.xcresult`
- Exported visual attachments: `/tmp/repo-cache-rwt-attachments` (80 PNGs)

Release-config note: the standard Release scheme still builds `Nexus HubTests`
when invoking a UI-only target, so it hits Apple's expected `ENABLE_TESTABILITY=NO`
`@testable import` failure. The optimized validation surface for this round is
ReleaseWithTesting, which inherits Release optimization flags with testability
enabled.

## Staging And Production Evidence

Not run in this source/local closure:
- Engine staging deploy and smoke.
- Google Drive staging dry-run/delete probe.
- Production Google Drive cleanup dry-run.
- Production promote.

Reason: Round A is closed as source/local validation for hostile QA. Production
and staging are intentionally left untouched until Felipe authorizes the
operator-gated promote path.

Required operator-gated follow-up before production promote:
1. Deploy `fix/p0-tenant-and-safety-2026-05` to staging.
2. Run staging smoke.
3. Run `scripts/cleanup-tainted-google-drive-sessions.mjs` dry-run on staging.
4. If staging dry-run finds synthetic contamination only, run `--yes` and verify
   `remainingCount: 0`.
5. Run production cleanup dry-run before source-side fix lands.
6. Promote only after hostile QA returns `READY_FOR_LOCAL_QA`.

## Issues Claude Missed

1. clean — Google Drive had the same family of global credential risk as Garmin, but the mechanism was service-level OAuth construction rather than token-row contamination.
2. fixed — Closed-beta invite display was implemented on iOS while the backend gate was incomplete. This is now server-enforced.
3. fixed — WebSocket tenant identity depended on `tenantId = userId`; now token and message paths revalidate canonical scope.
4. fixed — APNs sign-out was a backend data-retention gap, not just a local iOS cleanup gap.
5. fixed — Sentry `extra` and request context were under-redacted; both paths now sanitize.
6. dirty-but-deferred-with-reason — `resolveCurrentTenantIdForUser()` currently aliases tenant id to user id because production tenant enrollment still appears user-backed. Before true organization tenants launch, replace it with a DB-backed tenant enrollment lookup.
7. dirty-but-deferred-with-reason — Release UI-only test invocations still compile the unit-test target in the shared scheme. A dedicated UI-only Test Plan or scheme would remove the Release `@testable` trap.
8. dirty-but-deferred-with-reason — Finance collector filesystem sessions remain a separate follow-up from the launch-readiness sweep; this round did not touch Amazon/Uber collectors.
9. clean — Chat fastpath source-side cache audit found the pending-task cache key gap; no other fastpath cache key in the migrated path used the same user-only shape.
10. clean — Keychain migration is first-use scoped and does not delete scoped tokens for other users on sign-out.
11. clean — API cache safety valve is defensive and does not change cache key/value semantics.
12. dirty-but-deferred-with-reason — Parts 3-5 performance/accessibility fixes remain unstarted by design; launch-blocker safety work had priority.

## Hostile Self-Review

1. Tenant credential fallback: clean. Google Drive now requires per-user OAuth for user uploads; owner bootstrap is explicit only for system backup calls.
2. Tenant cache keys: clean. Chat fastpath pending-task keys include user and tenant.
3. WebSocket rotation: clean. Old tokens without tenant claims fall back to canonical lookup during rotation.
4. WebSocket tenant switch: clean. Message handling revalidates tenant scope before processing.
5. iOS sign-in race: clean. Repository loads wait on `signInComplete`.
6. iOS sign-out cleanup: clean. Keychain, deep links, onboarding state, and APNs binding are now scoped or cleared.
7. Invite gate: fixed. Backend enforcement was missing and is now covered.
8. Error exfiltration: fixed. Sentry request/extra/context payloads sanitize through the log-sanitizer path.
9. Cache growth: fixed. Cleanup has chunking, telemetry, and a supporting index.
10. Test quality: clean. New tests exercise public behavior or source-level contract where runtime WebSocket/UI orchestration would otherwise need heavier harnessing.
11. Staging readiness: dirty-but-deferred-with-reason. Staging was not touched in this source/local closure; it is required before production promote.
12. Production cleanup: dirty-but-deferred-with-reason. Production Drive dry-run was intentionally not run before hostile QA/operator authorization.

Secondary finding: tenant enrollment resolution is still effectively `tenantId === userId` in the current production model. This is acceptable for today's single-user tenant boundary but should become DB-backed before multi-member tenant/org support ships.

## Operator Follow-Ups

- Run hostile QA against the engine and iOS feature branches.
- If `READY_FOR_LOCAL_QA`, perform staging deploy/smoke and Google Drive cleanup dry-run/delete evidence capture.
- Capture production Google Drive cleanup dry-run before production promote.
- Promote engine only after Felipe authorization.
- Push iOS branch/main only after Felipe authorization.
- Do not cut TestFlight until this P0 branch and the later perf/accessibility branch clear hostile QA.
