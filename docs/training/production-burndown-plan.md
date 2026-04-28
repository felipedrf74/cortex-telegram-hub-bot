# Training Engine Production Burn-Down Plan

Updated: 2026-04-28  
Branch: `release/training-engine-production-hardening`  
Backup: `backup/training-prod-hardening-pre-20260428-1004` / `backup-training-prod-hardening-pre-20260428-1004` at `d0d0c41`

## 1. Executive Summary

Current backend readiness: **released to production at `4.14.100` with post-deploy read-only health green; production-safe mutation proof remains deferred until an approved safe test tenant/user/calendar is available**.

This pass closed the production-critical backend gaps that were still allowing impossible schedules or stale calendar identity state:

- fully booked calendar days now produce explicit `unscheduled` Training sessions instead of fallback agenda events;
- inactive lifecycle states survive persistence/read-model reconstruction and are excluded from active counts/calendar sync;
- calendar sync skips inactive sessions and updates provider event descriptions with fresh Training identity markers;
- generated plans expose `profileQuality` and `decisionReasons` for iOS/product surfaces.

The backend test gate is strong for the packaged local candidate:

- full `npm run verify`: 383 files / 6,001 tests passed;
- focused Training blocker suite: 14 files / 139 tests passed;
- Training eval: 99/100 across 156 cases.

The former external trust gates have now been closed: Google and Outlook provider smokes passed with read-back/cleanup, seeded cross-skill staging passed with cleanup, migration 082 passed on both local and true-staging clones, and production deployment completed through `./scripts/deploy.sh`.

Remaining conditions are now post-release validation/monitoring gates:

- iOS rich Training simulator smoke and authenticated local API journey have passed locally, but signed production iOS/device proof remains external;
- release copy must continue to avoid GPT-5.5 runtime claims because Training plan generation is deterministic/rule-based in this release;
- production-safe Training mutation/calendar checks require an approved safe production test tenant/user/calendar.

Production read-only health is green. It is not honest to claim production calendar mutation proof until a safe production test calendar is provided.

## 2. Open Task Inventory

| ID | Title | Area | Severity | Status | User impact | Root cause / evidence | Required validation |
|---|---|---|---|---|---|---|---|
| P0-01 | Clean integration candidate | Release hygiene | Critical | Fixed and pushed for review | Unsafe deploy/review if unreviewed | Backend branch head `b99098e` (code `b8f9be7`) and iOS branch head `b1aad7f` (code `537abf6`) are clean review candidates | Human review; rerun affected gates after any merge conflict resolution |
| P0-02 | Full backend verify | Backend QA | Critical | Fixed locally | Prevents regression release | `npm run verify` passed on packaged candidate | Rerun after future code changes |
| P0-03 | Google staging lifecycle smoke | Calendar trust | Critical | Closed / staging pass | Provider lifecycle is now proven in staging | Run `training-calendar-smoke-20260428165035-7ljwng` passed create/update/regenerate/cancel/retry/read-back/cleanup | Production-safe post-deploy provider check |
| P0-04 | Outlook staging lifecycle smoke | Calendar trust | Critical | Closed / staging pass | Provider lifecycle is now proven in staging | Run `training-calendar-smoke-20260428165107-7fsbbr` passed create/update/regenerate/cancel/retry/read-back/cleanup | Production-safe post-deploy provider check |
| P0-05 | iOS rich payload simulator smoke | iOS release | Critical | Fixed for local pre-release proof | Rich states could render poorly or stale | Rich fixture smoke, authenticated local API journey, and full iOS scheme passed | Signed/post-deploy validation after backend release |
| P0-06 | Rich feedback adaptation proof | Adaptive coaching | High | Downgraded to P1 | Feedback may not yet prove future adaptation end-to-end | Engine tests pass; iOS submit + future-plan proof remains | End-to-end feedback persistence/adaptation smoke |
| P0-07 | Event marker update gap | Calendar identity | High | Fixed locally | Stale markers weaken cleanup/read-back | Provider update APIs now accept `new_description` | Staging read-back after same-shape update |
| P1-01 | Cross-skill staging smoke | Orchestration | High | Closed / staging pass | Real Secretary/Cooking/Finance/Content signals now have staging proof | Run `training-cross-skill-smoke-20260428164946-829lm7` passed after seeded fixture setup and cleanup | Production-safe shared-context monitoring |
| P1-02 | Busy-window no-slot handling | Scheduling | High | Fixed locally | Prevents fake training times | Scheduler now reports `noAvailableSlot`; sync/persistence mark unscheduled | Focused tests + staging calendar smoke |
| P1-03 | Inactive state persistence | State model | High | Fixed locally | Prevents old/hidden unscheduled sessions after reload | Inactive states persisted before rest/mobility skip | Persistence/read-model tests |
| P1-04 | GPT-5.5 route evidence | Model config | High | Config/copy gate | Avoids overclaiming runtime intelligence | No provider routing changes in this pass | Explicit staging/prod model evidence or no claim |
| P1-05 | Profile quality/follow-up route | Personalization | High | Backend fixed | Weak-profile prompts can reach clients | Route now serializes `profileQuality` | iOS render/answer proof |
| P1-06 | Decision reasons route | Explainability | High | Backend fixed | Compression/reflow reasons can reach clients | Route now serializes `decisionReasons` | iOS grouped render proof |
| P1-07 | iOS QA Training gates | iOS release | High | Fixed locally; external device gate remains | Runtime UX may regress | Local rich fixture smoke + authenticated local API journey + full iOS scheme passed | Signed TestFlight/provider validation |
| P1-08 | Migration rollback drill | Data safety | High | Closed for release | Migration rollback path has staging and production-predeploy evidence | Local clone, true staging clone, and production-predeploy snapshot evidence exist | Keep snapshot path available during monitoring window |

## 3. GPT-5.5 Intelligence-Readiness Review

| Layer | Current status | Does it cap engine intelligence? | Notes |
|---|---|---|---|
| Backend contracts | Improved | Lower risk | `profileQuality` and `decisionReasons` now leave the backend route. |
| iOS DTOs/rendering | Locally validated | Lower risk | Rich payload smoke, DebugAuthTokenImporter, authenticated local journey, and full iOS scheme passed. |
| Feedback loop | Partially proven | Medium | Engine feedback-analysis tests pass; end-to-end rich iOS feedback remains open. |
| Catalog/dependency structures | Improved by prior work | Low/medium | Full verify and Training eval covered current catalog work. |
| Explanations/decision trail | Improved | Medium until iOS rendering | Backend serializes reasons; frontend display remains the productization step. |
| Schedule/calendar lifecycle | Staging-provider proven | Medium until production-safe mutation | Google/Outlook staging provider lifecycle passed; production writes remain deferred without safe test calendar. |
| Cross-skill context | Staging-runtime proven | Medium | Seeded staging tenant validation passed and cleanup was verified. |
| Evaluation harness | Good | Low | Final eval passed 99/100. |
| Model/provider config | Not proven | Medium/high for claims | Do not claim GPT-5.5 execution until config/runtime evidence exists. |

## 4. Trust-Gate Status

| Gate | Status | Evidence |
|---|---|---|
| Training engine regression tests | Passed locally | Focused suite: 13 files / 140 tests |
| Full backend verification | Passed locally | `npm run verify`: 383 files / 6,001 tests |
| Training eval | Passed locally | 99/100, 156 cases |
| Calendar lifecycle unit/contract tests | Passed locally | Calendar sync/persistence/schedule tests included in focused suite and full verify |
| Google staging smoke | Passed | Final gate `training-calendar-smoke-20260428165035-7ljwng`, provider read-back and cleanup passed |
| Outlook staging smoke | Passed | Final gate `training-calendar-smoke-20260428165107-7fsbbr`, provider read-back and cleanup passed |
| Cross-skill staging smoke | Passed | `training-cross-skill-smoke-20260428164946-829lm7`, seeded runtime checks passed and fixture cleanup was verified |
| iOS simulator rich Training smoke | Passed locally | Rich fixture smoke, authenticated local journey, and full iOS scheme passed on `537abf6` |
| Security/tenant checks | Passed via full verify | Existing tenant/security suites passed in `npm run verify` |
| Backward compatibility | Locally preserved | Additive route fields; inactive states preserve rows and skip calendar creation |
| Production rollback readiness | Ready | Backup branch/tag exists; migration rollback passed locally and on true staging clone; production-predeploy snapshot captured |

## 5. Final Execution Order

1. Monitor production `4.14.100` service health, DB integrity, Training logs, calendar sync failures, duplicate agenda events, and model/provider cost/latency.
2. Run production-safe authenticated API/iOS smoke when an approved safe production token is available.
3. Run production-safe Training create/cancel/regenerate and constrained-week checks only for an approved safe test tenant/user.
4. Run production calendar create/read/delete only against an approved safe test calendar.
5. Confirm rich feedback submit persists and changes future coaching before making broader adaptive-learning claims.
6. Run signed TestFlight/device validation for iOS rich Training states and provider-auth paths.

## 6. Do-Not-Merge List

Do not merge follow-up changes or run additional production writes:

- from unreviewed candidate branches;
- production calendar tests without an approved safe production test calendar;
- production Training mutations without an approved safe production test tenant/user;
- rich Training state claims beyond local pre-release proof without signed/post-deploy validation;
- GPT-5.5 execution claims without runtime model/provider evidence;
- adaptive feedback claims without end-to-end feedback persistence and future-plan adaptation evidence;
- broad calendar cleanup logic based only on dates/titles.

## 7. Production Readiness Criteria Summary

Training is production-ready only when:

- backend branch is clean and reviewed;
- backend full verify and Training eval pass on that clean commit;
- Google and Outlook staging lifecycle smokes pass with read-back/cleanup;
- iOS rich-payload simulator smoke passes;
- migration rollback is rehearsed locally and then proven on true staging/predeploy data;
- API/iOS docs match actual contracts;
- remaining P1 gates are either passed or explicitly scoped out by owner decision.

Current status: **PRODUCTION RELEASED at `4.14.100`; read-only post-deploy health is green; production-safe mutation/calendar proof remains deferred pending safe test tenant/calendar approval.**
