# Training Engine Production Burn-Down Plan

Updated: 2026-04-28  
Branch: `release/training-engine-production-hardening`  
Backup: `backup/training-prod-hardening-pre-20260428-1004` / `backup-training-prod-hardening-pre-20260428-1004` at `d0d0c41`

## 1. Executive Summary

Current backend readiness: **release-hardening branch is packaged and locally green, but not production-cleared**.

This pass closed the production-critical backend gaps that were still allowing impossible schedules or stale calendar identity state:

- fully booked calendar days now produce explicit `unscheduled` Training sessions instead of fallback agenda events;
- inactive lifecycle states survive persistence/read-model reconstruction and are excluded from active counts/calendar sync;
- calendar sync skips inactive sessions and updates provider event descriptions with fresh Training identity markers;
- generated plans expose `profileQuality` and `decisionReasons` for iOS/product surfaces.

The backend test gate is strong for the packaged local candidate:

- full `npm run verify`: 382 files / 5,994 tests passed;
- focused Training blocker suite: 14 files / 139 tests passed;
- Training eval: 99/100 across 156 cases.

The remaining no-go items are trust gates that require environment access or frontend runtime proof:

- Google and Outlook staging calendar lifecycle smokes are blocked by missing staging env/secrets;
- cross-skill staging smoke is blocked by missing staging env/test tenant;
- iOS rich Training simulator smoke and authenticated local API journey have passed locally, but signed/post-deploy proof remains external;
- migration 082 local clone apply/restore rehearsal has passed, but true staging DB clone proof remains pending;
- the backend/iOS candidate branches have been pushed for review; human review remains required before deployment.

Production is realistic after those external gates pass. It is not honest to call it production-ready before real calendar read-back and iOS runtime proof.

## 2. Open Task Inventory

| ID | Title | Area | Severity | Status | User impact | Root cause / evidence | Required validation |
|---|---|---|---|---|---|---|---|
| P0-01 | Clean integration candidate | Release hygiene | Critical | Fixed and pushed for review | Unsafe deploy/review if unreviewed | Backend branch head `b99098e` (code `b8f9be7`) and iOS branch head `b1aad7f` (code `537abf6`) are clean review candidates | Human review; rerun affected gates after any merge conflict resolution |
| P0-02 | Full backend verify | Backend QA | Critical | Fixed locally | Prevents regression release | `npm run verify` passed on packaged candidate | Rerun after future code changes |
| P0-03 | Google staging lifecycle smoke | Calendar trust | Critical | Blocked externally | Could ship missing/duplicate/stale calendar events | Missing staging env/OAuth/database/user | Real create/update/regenerate/cancel/read-back/cleanup |
| P0-04 | Outlook staging lifecycle smoke | Calendar trust | Critical | Blocked externally | Same as Google | Missing staging env/OAuth/database/user | Real provider read-back and cleanup |
| P0-05 | iOS rich payload simulator smoke | iOS release | Critical | Fixed for local pre-release proof | Rich states could render poorly or stale | Rich fixture smoke, authenticated local API journey, and full iOS scheme passed | Signed/post-deploy validation after backend release |
| P0-06 | Rich feedback adaptation proof | Adaptive coaching | High | Downgraded to P1 | Feedback may not yet prove future adaptation end-to-end | Engine tests pass; iOS submit + future-plan proof remains | End-to-end feedback persistence/adaptation smoke |
| P0-07 | Event marker update gap | Calendar identity | High | Fixed locally | Stale markers weaken cleanup/read-back | Provider update APIs now accept `new_description` | Staging read-back after same-shape update |
| P1-01 | Cross-skill staging smoke | Orchestration | High | Blocked externally | Real Secretary/Cooking/Finance/Content signals unproven | Local fixtures pass; staging env missing | Seeded staging tenant smoke |
| P1-02 | Busy-window no-slot handling | Scheduling | High | Fixed locally | Prevents fake training times | Scheduler now reports `noAvailableSlot`; sync/persistence mark unscheduled | Focused tests + staging calendar smoke |
| P1-03 | Inactive state persistence | State model | High | Fixed locally | Prevents old/hidden unscheduled sessions after reload | Inactive states persisted before rest/mobility skip | Persistence/read-model tests |
| P1-04 | GPT-5.5 route evidence | Model config | High | Config/copy gate | Avoids overclaiming runtime intelligence | No provider routing changes in this pass | Explicit staging/prod model evidence or no claim |
| P1-05 | Profile quality/follow-up route | Personalization | High | Backend fixed | Weak-profile prompts can reach clients | Route now serializes `profileQuality` | iOS render/answer proof |
| P1-06 | Decision reasons route | Explainability | High | Backend fixed | Compression/reflow reasons can reach clients | Route now serializes `decisionReasons` | iOS grouped render proof |
| P1-07 | iOS QA Training gates | iOS release | High | Fixed locally; external device gate remains | Runtime UX may regress | Local rich fixture smoke + authenticated local API journey + full iOS scheme passed | Signed TestFlight/provider validation |
| P1-08 | Migration rollback drill | Data safety | High | Partially closed | Real deployment DB rollback still needs staging/predeploy proof | Local clone rehearsal passed; true staging DB unavailable | Repeat apply/rollback/snapshot restore on true staging clone or deployment preflight snapshot |

## 3. GPT-5.5 Intelligence-Readiness Review

| Layer | Current status | Does it cap engine intelligence? | Notes |
|---|---|---|---|
| Backend contracts | Improved | Lower risk | `profileQuality` and `decisionReasons` now leave the backend route. |
| iOS DTOs/rendering | Locally validated | Lower risk | Rich payload smoke, DebugAuthTokenImporter, authenticated local journey, and full iOS scheme passed. |
| Feedback loop | Partially proven | Medium | Engine feedback-analysis tests pass; end-to-end rich iOS feedback remains open. |
| Catalog/dependency structures | Improved by prior work | Low/medium | Full verify and Training eval covered current catalog work. |
| Explanations/decision trail | Improved | Medium until iOS rendering | Backend serializes reasons; frontend display remains the productization step. |
| Schedule/calendar lifecycle | Locally stronger | High until staging | Real provider lifecycle smoke is mandatory. |
| Cross-skill context | Fixture-proven only | Medium | Staging tenant validation remains blocked. |
| Evaluation harness | Good | Low | Final eval passed 99/100. |
| Model/provider config | Not proven | Medium/high for claims | Do not claim GPT-5.5 execution until config/runtime evidence exists. |

## 4. Trust-Gate Status

| Gate | Status | Evidence |
|---|---|---|
| Training engine regression tests | Passed locally | Focused suite: 13 files / 140 tests |
| Full backend verification | Passed locally | `npm run verify`: 382 files / 5,994 tests |
| Training eval | Passed locally | 99/100, 156 cases |
| Calendar lifecycle unit/contract tests | Passed locally | Calendar sync/persistence/schedule tests included in focused suite and full verify |
| Google staging smoke | Blocked | Final gate `training-calendar-smoke-20260428142908-61fokl`, missing env/secrets |
| Outlook staging smoke | Blocked | Final gate `training-calendar-smoke-20260428142908-61fokl`, missing env/secrets |
| Cross-skill staging smoke | Blocked | `training-cross-skill-smoke-20260428142925-1lc554`, local fixtures passed; runtime checks require seeded staging data |
| iOS simulator rich Training smoke | Passed locally | Rich fixture smoke, authenticated local journey, and full iOS scheme passed on `537abf6` |
| Security/tenant checks | Passed via full verify | Existing tenant/security suites passed in `npm run verify` |
| Backward compatibility | Locally preserved | Additive route fields; inactive states preserve rows and skip calendar creation |
| Production rollback readiness | Partial | Backup branch/tag exists; DB migration rollback passed locally but still needs true staging/predeploy snapshot proof |

## 5. Final Execution Order

1. Review the pushed backend candidate `b99098e` (code payload `b8f9be7`) and iOS companion `b1aad7f` (code payload `537abf6`).
2. Run Google staging calendar smoke with read-back and cleanup.
3. Run Outlook staging calendar smoke with read-back and cleanup.
4. Rehearse migration apply/rollback on a true staging clone, or record an explicit deployment preflight snapshot/restore gate; local clone rehearsal is already complete.
5. Run cross-skill staging smoke on an isolated staging test tenant.
6. Confirm runtime model/provider configuration or keep GPT-5.5 runtime claims out of release copy.
7. Confirm rich feedback submit persists and changes future coaching before making adaptive-learning claims.
8. Update API/release docs, then make final go/no-go.

## 6. Do-Not-Merge List

Do not merge or deploy:

- from unreviewed candidate branches;
- calendar lifecycle changes without real Google/Outlook staging read-back proof;
- database identity migration without true staging or deployment-preflight rollback/snapshot proof;
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

Current status: **NO-GO for production, YES for staging validation once credentials/environments are available.**
