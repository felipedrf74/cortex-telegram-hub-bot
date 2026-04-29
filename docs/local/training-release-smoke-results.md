# Training Release Smoke Results

Run date: 2026-04-29
Run ID: `training-release-smoke-20260429T123931`
Backend branch: `feature/secretary-scheduling-arbitrator-batch4`
Backend version during smoke: `4.14.104`
Local base URL: `http://127.0.0.1:8216`
Local DB: `data/training-release-smoke-20260429T123931.db`
AI provider mode: deterministic/local fixture mode (`NEXUS_LOCAL_ALLOW_MODEL_CALLS=0`)

## Summary

Verdict: **PASS WITH CONDITIONS**

The local Training release smoke passed the local product-engine checks for auth, Training API plan creation, rich Training payload persistence, feedback submission, cancellation cleanup, regeneration duplicate prevention, cross-skill fixture behavior, tenant isolation, and iOS rich-payload decoding/rendering contracts.

Conditions:
- No real Google/Outlook provider writes were attempted in this local smoke. Calendar provider read-back remains covered by staging provider smoke, not this local run.
- Free-form live-model Chat was not used. The Chat-to-Training check used the token-zero Training route (`/training plan`) so the local run stayed deterministic and did not consume provider tokens.
- iOS validation used focused simulator unit tests and rich local fixtures. A manual iOS UI walkthrough against the local backend was not run in this pass.
- Cross-skill runtime staging was intentionally blocked in dry-run mode; local fixture contracts passed.

## Commands And Results

| Area | Command | Result | Evidence |
| --- | --- | --- | --- |
| Local cleanup before run | `scripts/full-nexus-local-engine.sh cleanup` with `FULL_NEXUS_RESET_DB=1` | PASS | Local smoke DB and auth token removed before run. |
| Local engine startup | `scripts/full-nexus-local-engine.sh up` on port `8216` | PASS WITH NOTE | Attached mode stayed stable. Detached `start` initially lost its listener after first health probe, so attached mode was used per runbook guidance. |
| Product health/auth smoke | `scripts/full-nexus-local-engine.sh smoke` | PASS | Health online; local user `2` registered; 13/13 authenticated iOS API smoke checks passed: Dashboard, Plan today/week, Task lists, Today tasks, Training summary/today, Content, Finance, Connections, Inbox. |
| Chat tenant/security smoke | `scripts/full-nexus-local-engine.sh chat-tenant-smoke` | PASS WITH CONDITIONS | 12 pass, 2 partial, 0 fail. No cross-tenant conversation/memory/prompt/attachment/tool leakage. Partials: multi-tenant same-user runtime not supported by current iOS ingress; no real provider fallback call. |
| Cross-skill fixtures | `scripts/full-nexus-local-engine.sh cross-skill-fixtures` | PASS WITH NOTE | Local fixture contracts passed for Secretary conflict pressure, Cooking fueling gap dedupe, Finance constraint, Content workload, and Training content milestone. Staging runtime section blocked by design in dry-run mode. |
| Focused Training local probe | Node API/DB probe against `http://127.0.0.1:8216/api/v1` | PASS | 10/10 checks passed. Created plan, persisted rich sessions, submitted feedback, canceled plan, terminalized agenda ownership, regenerated without active duplicate ownership rows, scoped rows to local user. |
| Training regression tests | `npm test -- __tests__/services/coach-kernel-constrained-week-capacity.test.ts __tests__/api/training-plan-persistence.test.ts __tests__/api/training-plan-cancellation.test.ts __tests__/api/training-plan-generation.test.ts __tests__/api/training-plan-calendar-sync.test.ts __tests__/services/coach-kernel-poor-recovery-variation.test.ts __tests__/services/training-plans.test.ts` | PASS | 7 files / 93 tests passed. |
| Backend typecheck | `npm run typecheck` | PASS | `tsc --noEmit` completed with no diagnostics. |
| iOS rich payload tests | `xcodebuild test ... -only-testing:Nexus HubTests/TrainingPresentationTests -only-testing:Nexus HubTests/TrainingLocalSmokeFixtureTests -only-testing:Nexus HubTests/TrainingFeedbackPayloadTests -only-testing:Nexus HubTests/TrainingHomeViewStateContractDecodingTests` | PASS | `TEST SUCCEEDED`; 38 focused Training tests passed on iPhone 17 Pro simulator. |
| Resource cleanup | `scripts/full-nexus-local-engine.sh cleanup` plus listener/simulator checks | PASS | Port `8216` had no listener; no matching local smoke processes; no booted iOS simulator remained. |

## Focused Training Probe

| Scenario | Expected | Actual | Result |
| --- | --- | --- | --- |
| Chat asks Training question | Chat routes Training question through Training domain without model spend | `POST /chat/message` with `/training plan` returned `status=200`, `domain=triathlon`, `route=keyword` | PASS |
| Training creates plan | Training API creates local plan from seeded profile | `POST /training/plan/generate` returned `status=201`, `planId=1`, `totalSessions=5`, `eventsCreated=0` | PASS |
| Secretary/local scheduler places sessions | Generated sessions expose active rich schedule states | Persisted session statuses: `scheduled` | PASS |
| Rich payload persisted | iOS-facing rich payloads exist | All 5 sessions had `description_json`, `session_identity_key`, and `session_shape_hash` | PASS |
| Feedback can be submitted | Completion feedback is persisted | `POST /training/complete` returned `status=200`; `training_completions=1` | PASS |
| Canceled plan cleans agenda | Cancellation deletes local sessions and moves ownership out of active | `status=200`; `remainingSessions=0`; `activeOwnerships=0`; `terminalOwnerships=1` | PASS |
| Regenerated plan does not duplicate events | Regeneration leaves a single active plan and no duplicate active ownership rows | `status=201`; `newPlanId=2`; `activePlans=1`; `activeOwnershipRows=0` | PASS |
| Tenant/user scoping holds | Training rows remain scoped to authenticated local user | `userAPlans=1`; `userBPlans=0` | PASS |

## Cross-Skill Evidence

Local fixture contracts passed:
- Secretary conflict pressure was visible to Training and produced reflow/modular guidance instead of locking an impossible schedule.
- Cooking fueling gap appeared once, with no duplicated generic warning.
- Finance constraint reduced spend-heavy recommendations.
- Content workload and filming windows were included as schedule friction.
- Training exposed a content-capture opportunity for Content Creation.

## iOS Evidence

The focused simulator suite proved iOS can decode and render:
- Rich mixed-modality Training week payloads.
- Lifecycle identity and calendar sync aliases.
- Unscheduled and superseded states without calendar pressure.
- Canceled/superseded lifecycle truth.
- Unknown enum values with safe fallbacks.
- Rich feedback payloads and local smoke fixture feedback application.

XCResult:
`/Users/felipedominguez/Library/Developer/Xcode/DerivedData/Nexus_Hub-gsoqdyrpqmkkotdmfddhuhobycvu/Logs/Test/Test-Nexus Hub-2026.04.29_13-48-40-+0100.xcresult`

## Harness Fix Applied

The Chat tenant smoke script used fixture values named `*_SECRET_*` with a 13-digit timestamp. The hardened shared-memory guard correctly rejected those values as credential/card-like. I changed the script to use harmless base36 smoke markers:
- `TENANT_A_CHAT_MARKER_*`
- `TENANT_B_CHAT_MARKER_*`
- `TENANT_B_SAME_USER_MARKER_*`

The tenant smoke then passed with no cross-tenant leakage.

## Cleanup

Cleanup passed:
- Local backend listener on `8216`: none.
- Matching local smoke processes: none.
- Local smoke DB removed by cleanup.
- Local auth token removed by cleanup.
- Booted iOS simulators: none.
