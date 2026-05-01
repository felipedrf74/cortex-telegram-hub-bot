# Cooking + Training Main / Production Go-No-Go

Date: 2026-05-01

## Verdict

Main merge: `MERGE_WITH_CONDITIONS`.

Production deployment: `DEPLOY_WITH_CONDITIONS`; no direct production deploy from this pass.

## Cooking

### Merge-To-Main

Verdict: `READY_TO_MERGE` with normal review/CI conditions.

Evidence:

- Backend branch `feature/cooking-intelligence-upgrade` at `c8dca78`.
- iOS Cooking branch `feature/cooking-rich-state-ui` at `7be4b6f`.
- `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 npx tsc --noEmit` passed.
- Focused Cooking/provider/portal tests passed: 6 files / 61 tests.
- Full backend verify passed in the `c8dca78` pre-commit hook: 429 files / 6426 tests.
- Portal browser smoke exists and passed against local backend, including forged tenant fail-closed state and stale-data clearing.
- Hardened portal auth browser smoke passed with `PORTAL_REQUIRE_SESSION_AUTH=true`, `PORTAL_ALLOW_LOCAL_BYPASS=false`, and a signed `ps_` admin session; invalid `ps_` login returned `401` and kept the login overlay visible before the valid session loaded scoped Cooking data.
- Backend substitution acceptance contract exists: `POST /api/v1/cooking/meal-plan/substitutions/apply` updates only the authenticated tenant's linked recipe/meal copy and regenerated shopping list; focused tests passed 45/45 for Cooking routes plus intelligence assessment.
- Focused iOS `CookingPresentationTests` passed: 13 tests.

Conditions:

- Merge through normal code review and CI.
- Confirm the unrelated iOS Content full-suite failures are either resolved or explicitly owned outside this Cooking branch before broad iOS release claims.

### Production

Verdict: `DEPLOY_WITH_CONDITIONS`.

Conditions:

1. Deploy exact Cooking RC to staging.
2. Run focused Cooking staging smoke: recipe create/read, meal-plan read-back, substitution apply/read-back, pantry/preference read/write, portal scoped load, tenant forged request denial, and iOS/API compatibility where applicable.
3. Keep local fixture-mode evidence distinct from any real-provider quality sampling.
4. Promote only after owner approval.
5. Run production health checks and log/tenant-denial monitoring after deploy.

No known Cooking P0/P1 blocks production after those gates.

## Training

### Merge-To-Main

Verdict: `READY_TO_MERGE` with normal review/CI conditions.

Evidence:

- iOS branch `feature/training-validation-and-coach-fixes` at `173ce5b`.
- `xcodebuild build-for-testing` passed on single simulator UDID `A0B13967-B5DE-4E6F-897D-F1E409093F94`.
- Focused Training iOS validation passed: 59 unit tests + 4 `TrainingFixtureBypassUITests`.
- Old `/tmp/ios-audit-2026-04-30.md` F1-F5 risks have current coverage:
  - multi-week API is consumed by `TrainingRepository.loadAll` and surfaced in the weekly plan timeline;
  - `applyLocalTodayStatus` preserves `calendarEventId`, `calendarSource`, and `calendarSyncState`;
  - `calendarLinkIsCurrent == false` is consumed by coach metrics;
  - `primaryFocusNote` is localized and surfaced in plan-generation result copy;
  - rich/no-plan fixture UI tests assert actual Training payload and create-plan sheet behavior, not just launch.

Conditions:

- Merge through normal iOS review and CI.
- Do not claim signed/device/provider production proof from simulator fixture tests.

### Production

Verdict: `DEPLOY_WITH_CONDITIONS`.

Conditions:

1. If Training backend candidate changed since the recorded provider smokes, rerun Google/Outlook non-production provider lifecycle smoke on the exact candidate.
2. Take production-predeploy DB snapshot immediately before backend deployment if migrations/data changes are in scope.
3. Run staging smoke.
4. Run signed TestFlight/device validation for fresh auth/onboarding, Apple Sign In, HealthKit/Apple Watch recognition, APNs token upload, and true account switching where in scope.
5. Run production-safe post-deploy validation with safe test tenant/user.

No known Training iOS P0/P1 code blocker remains from this pass.

## Exact Release Recommendation

1. Prepare one integration branch per release lane:
   - backend Cooking candidate from `feature/cooking-intelligence-upgrade`;
   - iOS Cooking candidate from `feature/cooking-rich-state-ui`;
   - iOS Training candidate from `feature/training-validation-and-coach-fixes`.
2. Run normal CI and review for each.
3. Merge only after CI/review clears.
4. Do not deploy production until staging smoke and owner approval are explicit.

## Monitoring Checklist For Deployment

- Cooking route failures, preference/pantry write failures, meal-plan read-back failures.
- Cooking tenant authorization failures and unusual cross-tenant attempts.
- Cooking portal admin/operator audit logs.
- Cooking provider/model call metadata; confirm no unexpected model calls in fixture paths.
- Training plan generation failures, calendar sync failures, duplicate event indicators, stale ownership rows.
- Training iOS decode/render errors for rich payloads.
- Calendar provider failure rate, latency, and auth expiration.
- Production-safe logs only; no raw sensitive prompt/context leakage.
