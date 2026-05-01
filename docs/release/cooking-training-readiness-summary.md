# Cooking + Training Readiness Summary

Date: 2026-05-01

## Executive Summary

| Workstream | Merge-to-main readiness | Production readiness | Confidence | Summary |
| --- | --- | --- | --- | --- |
| Cooking backend | READY_TO_MERGE with conditions | NOT DIRECT-DEPLOY READY | Medium-high | No known P0/P1 remains. Backend typecheck, focused Cooking/provider/portal/substitution-apply tests, full `npm run verify`, local product smoke, portal smoke, and iOS focused rendering evidence are available. Production still needs normal staging, staging smoke, owner approval, and production health. |
| Cooking iOS | READY_TO_MERGE with conditions | NOT DIRECT-DEPLOY READY | Medium | Focused `CookingPresentationTests` passed 15/15 on a single simulator, including future adaptation-kind fallback and unknown substitution metadata readability. Prior live local UI proof rendered backend substitution candidates. Full iOS suite has unrelated Content failures in the prior Cooking validation report, so merge should rely on focused Cooking evidence plus normal iOS CI/review. |
| Training iOS | READY_TO_MERGE with conditions | NOT DIRECT-DEPLOY READY | Medium-high | The old `/tmp/ios-audit-2026-04-30.md` DO-NOT-SHIP findings are superseded by `c83ee42`/`173ce5b`: multi-week data is consumed, calendar fields are preserved, primary-focus notes render, and rich fixture UI tests pass. Production still requires provider-backed/non-production calendar smoke where applicable and signed TestFlight/device gates for auth/Health/APNs/account switching. |
| Training backend/provider gates | READY_TO_MERGE with conditions | DEPLOY_WITH_CONDITIONS only | Medium-high | Existing Training release docs report Google/Outlook staging lifecycle and cross-skill staging smoke passed for the Training release candidate. This pass did not redeploy or rerun staging/provider smokes. |

Overall recommendation: `MERGE_WITH_CONDITIONS`, then `DEPLOY_WITH_CONDITIONS` only after the standard staging and production gates. Do not push or deploy directly from this pass.

Highest remaining risk: not a code P0/P1. The highest remaining release risk is operational evidence freshness: final staging smoke, production-predeploy snapshot where migrations are involved, production-safe health checks, and signed device/TestFlight validation are still required before broad production/user rollout.

## Reports And Evidence Reviewed

| Path | Workstream | Claimed verdict | Evidence level | Key open items | Confidence impact |
| --- | --- | --- | --- | --- | --- |
| `docs/qa/cooking-codex-revalidation-fixes.md` plus current hardened portal/substitution passes | Cooking | Medium-high confidence after fixes | E4/E5 | P2 portal deep editors and iOS direct accept affordance | High signal; includes adversarial tests, full verify, local smoke, iOS focused tests, portal browser smoke, hardened signed-session invalid-auth browser proof, backend substitution application tests, and portal substitution-acceptance route/UI tests. |
| `docs/cooking/cooking-final-report.md` | Cooking | backend candidate PASS WITH CONDITIONS | E4/E5 | normal staging/prod gates; no P0/P1 | Updated in this pass to current `429/6434` full verify and portal smoke evidence. |
| `docs/cooking/cooking-production-open-blockers.md` | Cooking | no P0/P1 known | E2/E4 | P2 deeper portal editors, iOS direct substitution accept, enum fallback tests | Supports merge readiness; not unconditional production readiness. |
| `docs/cooking/cooking-local-smoke-results.md` | Cooking | PASS / PASS WITH CONDITIONS by area | E4/E5 | fixture routing, not real-provider quality sampling | Useful local product evidence. |
| `docs/ios/cooking-ios-readiness.md` | Cooking iOS | readiness tracked separately | E2/E5 | richer visual treatment/future states | Focused iOS surface evidence, not full-device proof. |
| `docs/ios/training-rich-payload-smoke.md` | Training iOS | Post-follow-up closure | E2/E5 | provider-backed calendar smoke; signed TestFlight/device gates | High signal for the old iOS audit findings; records `TrainingFixtureBypassUITests` 4/4 and focused unit pack evidence. |
| `/tmp/ios-audit-2026-04-30.md` | Training iOS | DO-NOT-SHIP hypothesis report | E1/E5 snapshot, superseded | F1-F5 were real at audit time but have since been addressed or constrained | Important historical risk map, not current verdict. |
| `docs/training/training-release-gate.md` | Training backend | PASS WITH CONDITIONS | E4/E5 | provider staging and live-model claims separated | Supports candidate readiness, with explicit conditions. |
| `docs/training/final-production-go-no-go.md` | Training backend | GO WITH CONDITIONS for deployment prep | E5/E6 | production snapshot, owner approval, production-safe post-deploy validation | Strong release-plan evidence, not a deploy approval. |
| `docs/training/production-open-blockers.md` | Training backend | no known backend P0/P1 implementation gap | E3/E6 | deployment process conditions | Useful for production gate conditions. |

## Current Repo State

### Cooking Backend

- Path: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot`
- Branch: `feature/cooking-intelligence-upgrade`
- Commit: `c01cace feat(cooking): add portal substitution acceptance`
- Dirty state at start of this pass: clean.
- Recent commits: `c8dca78`, `98f6860`, `cf3d7af`, `32286ac`, `aead9a6`.

### Cooking iOS

- Path: `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub Cooking UI Worktree`
- Branch: `feature/cooking-rich-state-ui`
- Commit: `8a5bdad fix(cooking): tolerate future adaptation kinds`
- Dirty state at start of this pass: clean.
- Recent commits: `7be4b6f`, `d7eb9f4`, `e8cdc80`, `cfe5df4`, `f4f1053`.

### Training iOS

- Path: `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub`
- Branch: `feature/training-validation-and-coach-fixes`
- Commit: `173ce5b docs(training): record remaining validation gates`
- Dirty state at start of this pass: clean.
- Recent commits: `173ce5b`, `c83ee42`, `0524a61`, `77d706b`, `4a233cb`.

## Validation Run In This Pass

| Area | Command | Result | Confidence impact |
| --- | --- | --- | --- |
| Environment cleanup | `xcrun simctl shutdown all`; `osascript ... quit`; `lsof` checks for `8200`/`8326` | PASS | Avoided simulator-clone and stale-service contamination. |
| Cooking backend typecheck | `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 npx tsc --noEmit` | PASS | Confirms current backend branch compiles. |
| Cooking focused tests | `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 npx vitest run __tests__/services/cooking-preferences.test.ts __tests__/services/cooking-intelligence.test.ts __tests__/api/cooking-routes.test.ts __tests__/portal/portal-cooking-routes.test.ts __tests__/portal/portal-cooking-ui.test.ts __tests__/services/provider-registry-fixture-mode.test.ts` | PASS, 6 files / 61 tests | Confirms current Cooking route, tenant, substitution, portal, and fixture-provider safety. |
| Portal substitution acceptance tests | `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 npx vitest run __tests__/portal/portal-cooking-ui.test.ts __tests__/portal/portal-cooking-routes.test.ts __tests__/api/cooking-routes.test.ts` | PASS, 3 files / 52 tests | Confirms the new portal operator panel calls guarded backend contracts and rejects cross-tenant/invalid substitution mutations before service access. |
| Cooking full backend verify | `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 npm run verify` | PASS, 429 files / 6434 tests | Strong current full-suite evidence after the portal substitution-acceptance pass. |
| Training iOS build-for-testing | `xcodebuild build-for-testing ... -destination 'id=A0B13967-B5DE-4E6F-897D-F1E409093F94' -parallel-testing-enabled NO -maximum-concurrent-test-simulator-destinations 1` | PASS | Confirms branch builds with the UI test target. |
| Training focused tests | `xcodebuild test ... PlanGenerateResponsePrimaryFocusTests, TrainingTodayCalendarSyncStateTests, TrainingRepositoryAllWeeksTests, TrainingWeekResponsePlanSyncStatusTests, TrainingLocalSmokeFixtureTests, TrainingPresentationTests, TrainingViewModelObservationTests, TrainingFixtureBypassUITests` | PASS, 59 unit tests + 4 UI tests | Directly validates the old F1-F5 audit risks and the rich fixture UI harness. |
| Cooking iOS focused tests | `xcodebuild test ... -destination 'id=A0B13967-B5DE-4E6F-897D-F1E409093F94' ... -only-testing:"Nexus HubTests/CookingPresentationTests"` in Cooking worktree | PASS, 15 tests | Confirms the Cooking rich-state iOS presentation slice and future-state fallbacks still pass. |

## Frontend Interaction Validation

### Cooking

- Simulator/device: iPhone 17 Pro / iOS 26.4 / `A0B13967-B5DE-4E6F-897D-F1E409093F94`.
- Current pass: focused `CookingPresentationTests` passed 15/15 on a single explicit simulator UDID.
- Prior verified interaction: local backend `127.0.0.1:8200`, fixture model mode, authenticated local seed with `Peanut recovery noodles` and `peanuts` allergy. iOS rendered the meal card, blocked signals, allergy/grocery issues, and substitution candidates `peanuts -> sunflower seed butter` / `peanuts -> roasted chickpeas`.
- Portal interaction: `npm run smoke:cooking:portal` passed after the stale-data clear fix; forged tenant `9002` fails closed without stale tables.
- Hardened portal auth interaction: `PORTAL_REQUIRE_SESSION_AUTH=true`, `PORTAL_ALLOW_LOCAL_BYPASS=false`, and a signed `ps_` admin session passed the browser smoke with `--probe-invalid-auth`; invalid `ps_` login returned `401` and kept the login overlay visible before the valid session loaded Cooking.
- Untested paths: direct iOS accept affordance and deep recipe/meal-plan/grocery portal editors. Backend and portal substitution application contracts are tested.

### Training

- Simulator/device: iPhone 17 Pro / iOS 26.4 / `A0B13967-B5DE-4E6F-897D-F1E409093F94`.
- Single-device control: only this UDID was booted; all xcodebuild commands used `-destination 'id=A0B13967-B5DE-4E6F-897D-F1E409093F94'` with parallel simulator destinations disabled.
- Interactions validated by UI tests: rich fixture bypass, Training payload-at-launch, weekly plan open, weekly timeline plan title `Local Rich Hybrid Block`, count-aware calendar banner, no-plan create-plan sheet, strength stepper reaching value `5`.
- Rich fixture/payload rendered: yes, by `TrainingFixtureBypassUITests` and the focused unit presentation pack.
- Untested paths: live provider-backed Google/Outlook calendar write/read-back from this iOS branch, signed TestFlight/device auth/Health/APNs/two-account switching.

## Readiness Verdict

### Cooking

- READY_TO_MERGE_MAIN: YES, with conditions.
- READY_FOR_PRODUCTION: NO for direct production deploy; DEPLOY_WITH_CONDITIONS after staging.
- Confidence: MEDIUM-HIGH.
- Conditions:
  - Merge only through normal review/CI; do not bypass the unrelated iOS full-suite Content failures if they are still present in the main iOS CI lane.
  - Run staging smoke against the exact release candidate before production.
  - Preserve `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0` fixture mode for local smoke; use real-provider sampling only by explicit approval.
- Reason: no open Cooking P0/P1 found; current backend and iOS focused validations pass; remaining issues are P2/P3 product workflow or operational gates.

### Training

- READY_TO_MERGE_MAIN: YES, with conditions.
- READY_FOR_PRODUCTION: NO for direct production deploy; DEPLOY_WITH_CONDITIONS after external gates and owner approval.
- Confidence: MEDIUM-HIGH.
- Conditions:
  - Keep old `/tmp/ios-audit-2026-04-30.md` as superseded, not current.
  - Retain the May 1 fixture-harness tests as the source of truth for the old iOS audit risks.
  - Before production/user rollout, complete/accept provider-backed calendar staging proof for the exact candidate where applicable, signed TestFlight/device smoke, and production-safe post-deploy validation.
- Reason: old F1-F5 iOS blockers now have current code/test coverage; remaining gates are external runtime/provider/device validation, not safe local code fixes.

## Next-Priority Task Selected

- Selected task: P2 docs/evidence drift and missing consolidated release docs.
- Why selected: no safe P0/P1 remained after current validation. Stale evidence in `docs/cooking/cooking-final-report.md` and missing `docs/release/cooking-training-*` docs could mislead release decisions.
- Fix scope: docs only. Updated Cooking final evidence and created consolidated readiness/open-items/next-task/go-no-go docs.
- Validation: no code behavior changed. `git diff --check` should pass before commit.

## Remaining Blockers

### P0

None known for Cooking or Training from this pass.

### P1

None known as merge blockers from this pass.

Production deployment conditions that remain P1 operational gates:

- Exact-candidate staging deployment and staging smoke.
- Production-predeploy DB snapshot where migrations or backend data changes are included.
- Production-safe post-deploy health checks with safe test tenant/user.
- Signed TestFlight/device validation for iOS auth/onboarding, Apple Sign In, HealthKit/Apple Watch recognition, APNs token upload, and real account switching where in scope.

### P2

- Cooking portal deep recipe/meal-plan/grocery editors.
- Cooking iOS direct substitution accept affordance.
- Cooking stronger allergy/restriction visual treatment. Unknown/future adaptation-kind fallback tests are closed on iOS commit `8a5bdad`.
- Training provider-backed calendar read-back from exact release candidate if the candidate changed since the recorded provider smokes.
- Training rich feedback end-to-end proof that future plans adapt, before making adaptive-learning claims.

### P3

- Cooking cuisine/style ontology, leftover/waste optimizer, item-price budget optimizer.
- Broader screenshot automation for dense Training/Cooking layouts.

## Merge Recommendation

Recommendation: `MERGE_WITH_CONDITIONS`.

Conditions:

1. Run normal backend/iOS CI for the exact merge candidates.
2. Confirm no unrelated iOS full-suite failures are being hidden by focused Cooking/Training passes.
3. Keep Cooking backend, Cooking iOS, and Training iOS branches separate during review unless an explicit integration branch is prepared.
4. Do not rewrite or force-push the current branches.

## Production Recommendation

Recommendation: `DEPLOY_WITH_CONDITIONS`.

Conditions:

1. Do not deploy directly from this readiness pass.
2. Deploy exact RC to staging first.
3. Run focused Cooking + Training staging smoke.
4. Take a fresh production DB snapshot immediately before production deploy if backend migrations/data changes are in scope.
5. Promote only after staging smoke passes and owner approval is explicit.
6. Run production health checks and iOS production-safe compatibility checks after deploy.

## Cleanup Status

- Ports `8200` and `8326`: clear before validation and after validation.
- Local services: none started in this pass.
- Simulator: selected single iPhone 17 Pro for iOS validation; `xcrun simctl shutdown all` run after validation and no booted devices remain.
- DB files: no `cooking-*.db` files remain.
- Provider-call loops: none started; Cooking backend tests used `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0`.
- Production data/calendars: not used.
