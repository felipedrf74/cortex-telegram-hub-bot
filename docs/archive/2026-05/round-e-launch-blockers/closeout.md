# Round E — Launch Blockers Closeout

Date: 2026-05-10
Status: SOURCE_AND_STAGING_VALIDATION_COMPLETE
Engine branch: `feature/round-e-launch-blockers-2026-05`
Engine head: `92501358`
iOS branch: `feature/round-e-launch-blockers-2026-05`
iOS head: `4bea028`

## Diagnosis

Round E consolidated the remaining Wave 1 launch blockers from:

- Decision Center + APNs hostile QA: `docs/release/decision-center-orchestration-apns-qa.md`
- Sixth-pass App Store/GDPR/LLM hardening audit
- `docs/PRIORITIZED_BACKLOG.md`

The decision-center branch was superseded by cherry-picking/porting the useful foundation into the Round E branch, then closing the Round D P0/P1 gaps there. The original `feature/decision-center-orchestration-apns` branch is preserved as evidence.

## Part 0 — F-A TenantId Source Audit

Verdict: CLEAN_FOR_WAVE_1, downgraded to Wave 2 prep.

Report: `docs/release/f-a-tenantid-source-audit.md`

Every Node caller of Python content-engine passes tenant identity from authenticated/JWT-derived scope or trusted server context. No app-facing route forwards a client body `tenantId` into Python content-engine.

## Part 1 — Decision Center Round D

| Item | Status | Evidence |
|---|---|---|
| P0-1 APNs sandbox/prod token environment | Fixed | `src/services/apns-sender.ts:212`, `:351`, `:495`; staging probe verified sandbox and production token hosts separately |
| P0-2 old push tokens revoked on user switch | Fixed | `src/services/notification-orchestrator.ts:1058`, `:1097`, `:1130`; `src/api/routes/settings.ts:156` |
| P0-3 iOS action failure preserves list | Fixed | `Nexus Hub/Views/Inbox/NotificationDecisionCenterView.swift:27`, `:86`, `:265`, `:321` |
| P0-4 Home a11y IDs added | Fixed | `Nexus Hub/Views/Dashboard/DashboardHomePrimarySections.swift:247`, `:254`, `:256` |
| P0-5 Decision Center scope discard | Fixed | `NotificationDecisionCenterView.swift:86`; `DashboardView.swift:965`, `:1012` |
| P1-1/P1-2 idempotency transaction + required key | Fixed | `src/services/decision-center.ts:359`, `:729`, `:779`; `src/api/routes/decisions.ts:209` |
| P1-3 fixtures require internal secret everywhere | Fixed | `src/api/routes/decisions.ts:87`, `:93`, `:108`, `:117` |
| P1-4 migration 119 replay idempotent | Fixed | `migrations/119_decision_center_facade.sql` with replay coverage |
| P1-5 fresh DB read-back | Fixed | `src/services/decision-center.ts:844`, `:853`, `:901` |
| P1-6 classifier/cannot-skip coverage | Fixed | `scripts/changed-area-classifier.sh`; classifier now returns cannot-skip and vitest globs for `decision-center.ts` |
| P1-7 decision collapse-id + badge | Fixed | `src/services/apns-sender.ts:388`; `src/services/decision-center.ts:341`; `src/services/notification-orchestrator.ts:1442` |
| P1-8 foreground APNs duplicate suppression | Fixed | `Nexus Hub/Core/AppDelegate.swift:118` |
| M-1 same-tenant isolation | Added | `__tests__/services/decision-center.test.ts` |
| M-2 same-userId cross-tenant isolation | Added | `__tests__/services/decision-center.test.ts` |
| M-3 concurrent duplicate action | Added | `__tests__/services/decision-center.test.ts` |
| M-4 stale status action denial | Added | `__tests__/services/decision-center.test.ts` |
| M-5 read-back mismatch | Added | `__tests__/services/decision-center.test.ts` |
| M-6 APNs payload privacy | Added | `__tests__/services/notification-orchestrator.test.ts` |
| M-7 wrong-user notification action denial | Added | `__tests__/api/decisions-routes.test.ts` |
| M-8 body-injected token scope ignored | Added | `__tests__/api/notifications-routes.test.ts` |

Part 1 commits:
- Engine: `4e0bb152`, `7644b2e3`
- iOS: `26581de`, `8943221`

Part 1 validation:
- Engine focused Decision/APNs suite: 5 files / 84 tests PASS.
- Classifier probe: `notification-apns-delivery-and-tenant` cannot-skip returned, with Decision/APNs vitest globs.
- Cannot-skip dashboard: 34/34 PASS.
- iOS focused unit: 11 tests PASS.
- iOS NotificationDecisionCenter UI: 5 tests PASS.
- iOS Release visual matrix: 21/21 PASS, 80 PNG attachments.
- iOS ReleaseWithTesting unit: 1264 XCTest + 10 Swift Testing PASS.

## Part 2 — App Store, GDPR, LLM Injection

| Item | Status | Evidence |
|---|---|---|
| C1.1 Sign in with Apple revocation | Fixed | `Nexus Hub/Core/AuthManager.swift:12`; app foreground/cold launch checks; notification listener coverage |
| C2.1 account deletion completeness | Fixed | `src/services/user-data-export.ts:148`, `:274`; `src/api/routes/settings.ts` delegates to transactional service |
| C2.2 OAuth revocation before delete | Fixed | `src/services/user-data-export.ts:90`, `:102`, `:122`, `:137` |
| C2.3 audit retention policy | Fixed | `docs/legal/data-retention.md:13`; code retains audit trail for legal proof |
| C3.1 prompt interpolation sanitizer | Fixed | `src/utils/prompt-sanitizer.ts:19`; `context-engine.ts:135`, `:156`, `:178`; `chat-context-engine.ts:374` |
| C3.1 shared memory authorization | Fixed | `src/services/chat-tool-authorization.ts:32` |
| C4.1 sign-out atomicity | Fixed | `Nexus Hub/Core/AppState.swift:532`, `:692`, `:704` |
| C4.2 background sync user binding | Fixed | `Nexus Hub/Core/BackgroundSyncManager.swift:33`, `:43` |
| C4.3 account-delete push token chain | Fixed | `Nexus Hub/Core/AppState.swift:346`; `Nexus Hub/Core/Services/SettingsService.swift:28` |
| C4.4 deep-link action scope validation | Fixed | `Nexus Hub/Core/DeepLinkRouter.swift:107`, `:310` |

Part 2 commits:
- Engine: `9a13c91d`
- iOS: `9c45a6a`

Part 2 validation:
- Engine focused suite: 5 files / 54 tests PASS.
- Engine pre-commit focused suite: 13 files / 130 tests PASS.
- iOS focused Part 2 suite: 5 tests PASS.

## Part 3 — Sentry, Cache Safety, Onboarding Scope

| Item | Status | Evidence |
|---|---|---|
| C5.1 Sentry redaction expansion | Fixed + pinned | `src/services/error-tracker.ts:44`, `:87`, `:133`, `:155`; `src/services/error-monitor.ts` sanitized extras |
| C5.2 api_cache safety valve | Fixed | `src/services/cache-store.ts:109`, `:359`, `:375`, `:381`; migration `117_api_cache_expires_key_index.sql` |
| C5.3 onboarding step user-scoped | Fixed | `Nexus Hub/Core/OnboardingStepStorage.swift:3`; `OnboardingFlowView.swift:51`, `:57`, `:61`, `:608` |
| Mock lint strict regression | Fixed | Reduced strict partial mocks from 834 to 823, below 827 baseline |

Part 3 commits:
- Engine: `3ee820c4`, `92501358`
- iOS: `4bea028`

Part 3 validation:
- Engine Part 3 suite: 4 files / 25 tests PASS.
- Engine combined focused suite: 14 files / 163 tests PASS.
- Engine pre-push suite: 24 files / 283 tests PASS.
- iOS onboarding scope suite: 2 tests PASS.

## Behavioral Evidence

Engine:
- Typecheck: PASS (`npx tsc --noEmit --pretty false`).
- Decision/APNs focused suite: 84 tests PASS, grown from the 71-test hostile-QA baseline.
- Combined focused suite: 14 files / 163 tests PASS.
- Pre-push focused suite: 24 files / 283 tests PASS.
- Strict mock lint: PASS, 823 partial mocks vs baseline 827.
- Changed-area classifier: PASS; `src/services/decision-center.ts` maps to cannot-skip and Decision/APNs vitest globs.
- Cannot-skip dashboard: 34/34 PASS.
- Staging deploy: PASS.
- 5-minute soak: PASS.
- Staging smoke: PASS 18/18.
- Docs audit: PASS, 463 issues (under 480).

iOS:
- Clean simulator build: PASS, zero compiler warnings in `/tmp/round-e-ios-clean-build-20260510T215524Z.log`.
- ReleaseWithTesting full unit: PASS, 1270 XCTest + 10 Swift Testing.
- Release visual matrix: PASS, 21/21 tests, 80 PNG attachments.

Evidence paths:
- Staging smoke: `engine/docs/release/smoke-evidence/staging-smoke-92501358-20260510T215221Z.json`
- Staging APNs/wrong-user action probe: `engine/docs/release/smoke-evidence/round-e-staging-decision-apns-probes-20260510T215456Z-clean.json`
- Release visual matrix xcresult: `/Users/felipedominguez/Library/Developer/Xcode/DerivedData/Nexus_Hub-gsoqdyrpqmkkotdmfddhuhobycvu/Logs/Test/Test-Nexus Hub Release UI Validation-2026.05.10_22-58-55-+0100.xcresult`
- ReleaseWithTesting unit xcresult: `/Users/felipedominguez/Library/Developer/Xcode/DerivedData/Nexus_Hub-gsoqdyrpqmkkotdmfddhuhobycvu/Logs/Test/Test-Nexus Hub-2026.05.10_22-56-08-+0100.xcresult`
- iOS clean build log: `/tmp/round-e-ios-clean-build-20260510T215524Z.log`

## Staging Probe Results

The staged APNs probe registered sandbox and production tokens for the same user and verified:

- sandbox token dispatched through sandbox APNs host.
- production token dispatched through production APNs host.
- decision push collapse id set as `decision:<decisionId>`.
- wrong-user decision action returned 404 `DECISION_NOT_FOUND`.
- wrong-user action created zero execution rows.

## Issues Claude Missed

- Fixed: hostile QA correctly caught that the first Decision Center closeout over-claimed APNs environment, scope-discard, a11y identifiers, idempotency, and test coverage.
- Fixed: strict mock lint was not included in the original Part 3 local proof and initially climbed above baseline; Round E closed it at 823.
- Dirty-but-deferred-with-reason: operator-physical TestFlight, real-device APNs, real two-account hardware checks, ToS/application form, and invite operations remain outside source round scope.
- Clean: F-A content-engine tenantId audit found no client-body tenantId path.

## Hostile Self-Review

1. Could a client forge `tenantId` into Python content-engine? No, Part 0 found Node callers derive scope server-side.
2. Could APNs sandbox/prod tokens be mixed? Fixed and staged with dual-token host assertions.
3. Could User A keep a live token after User B binds the same device? Fixed by revocation on rebind.
4. Could User B action User A's decision from an APNs payload? Staging probe returned 404 and zero execution rows.
5. Could duplicate taps write twice? Concurrent idempotency tests cover single execution row.
6. Could missing idempotency silently fallback to a weak key? Fixed with 400 `IDEMPOTENCY_KEY_REQUIRED`.
7. Could read-back trust a writer return? Fixed with fresh SELECT and mismatch test.
8. Could Decision Center hold stale User A state after sign-out/sign-in? iOS scope-discard and tests added.
9. Could action failure erase the in-progress list? iOS now shows inline failure and preserves retry.
10. Could sensitive decision copy leak in APNs alert body? Privacy tests cover finance/training/calendar/content-sensitive substrings.
11. Could account deletion leave notification/Garmin/agent/encryption/config rows? Deletion service and regression coverage expanded.
12. Could OAuth tokens remain valid after account deletion? Google/Microsoft revoke paths tested; Garmin documented local-only because no stable public revoke endpoint exists.
13. Could prompt injection through titles/memory alter LLM state? Sanitizer strips controls/sentinel labels and JSON-quotes values.
14. Could docs overstate verification? Evidence paths and exact counts are included above.

Secondary finding: mock-lint strict was a hidden regression after adding tests. It is now below baseline, but Round E shows this gate should remain mandatory after test-heavy security rounds.

## Cleanup Contract

- Production not deployed.
- Engine `main` not pushed.
- iOS `main` not pushed.
- TestFlight not cut.
- Backup tags pushed before changes:
  - `backup/round-e-engine-before-20260510-2149`
  - `backup/round-e-ios-before-20260510-2150`
- Existing Decision Center branch preserved.

## Operator Follow-Ups

After hostile QA:

1. Promote engine Round E through the validated promote pipeline.
2. Push iOS Round E to main only after QA approval.
3. Perform operator-physical TestFlight archive/upload.
4. Complete real-device APNs, two-account switching, provider-state, onboarding, and invite-list validation.
5. Keep P2/P3 backlog deferred to Wave 2 prep after 2-4 weeks of Wave 1 feedback.
